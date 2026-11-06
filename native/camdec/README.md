# camdec

The video half of jap-cams (BMW iDrive 7 MGU, Atom A3960, Intel HD 505):
reads the live Annex-B H.264 stream from the jap-cams server on stdin,
decodes it on the GPU with the unit's Intel Media SDK and writes I420
frames to mgu-render's video file (MGVF, mgu-render `PROTOCOL.md`, "Video"),
at a steady cadence from the stream's SPS frame rate.

## Where the code comes from

| File | Origin | Changes |
|---|---|---|
| `src/nal_reader.*`, `test/nal_reader_test.cpp` | idrive-apps' waze-on-cluster, via RideTube's `native/ytdec` | none |
| `src/decoder_msdk.*` | RideTube's `native/ytdec` (waze-on-cluster's decoder) | VPP removed; output straight to app-allocated system-memory NV12 surfaces (`IOPATTERN_OUT_SYSTEM_MEMORY`, page-aligned, pitch rounded to 64), MSDK GPU copy kept (`MFXInitEx GPUCopy ON`, `CAMDEC_GPUCOPY` overrides); decoding order `DecodedOrder 1` + `AsyncDepth 1` as Moonride's `native/mgu-moonlight`; frames carry a `hold` so a queue on another thread can keep surfaces (pool = suggested + 6); any failed access unit fails `feed()` at once; `reset()`; no timestamps; whole access units in (no inner re-framing) |
| `src/mgvf.*` | RideTube's `native/ytdec` | namespace; `nv12_to_i420` is SSE2 with non-temporal stores (old loop kept as `nv12_to_i420_ref`); `commit()` fences them |
| `src/main.cpp` | new; `crash_hygiene`, `emit`, `log_line`, `cpu_pct` from ytdec / mgu-moonlight | |
| `src/feeder.*`, `src/pacer.h`, `test/*`, `tools/feed.py`, `tools/smoke.py` | new | |
| `abi/`, `tools/abi.py`, `tools/ramses_abi.py`, `tools/woc_abi.py`, `LICENSE` | RideTube's `native/ytdec` | none |
| `docker/Dockerfile` | idrive-apps' `native/cluster-render/docker` | none |

## Build

```sh
export TMPDIR=$HOME/tmp   # on a Mac: Docker cannot mount /var/folders
make test      # host: unit tests + smoke test (fake decoder, ffmpeg test files)
               #   SMOKE_EXTRA="a.h264 ..." adds real captures to the smoke test
make target    # build/target/camdec in docker/Dockerfile's image (Ubuntu 18.04, gcc 7.5,
               # glibc 2.27, x86_64) against stubs of the unit's libmfxhw64 / libva /
               # libva-drm; loader, glibc/libstdc++ levels and every import checked;
               # the unit tests run there too (SSE2 converter vs the scalar reference)
```

The host is an arm64 Mac: there the converter test can only check the scalar
path; the SSE2 path is checked in the x86_64 image (`make target`).

## Interface

```
camdec --out /dev/shm/jap-video-cams [--log FILE]
```

stdin: raw Annex-B H.264, any chunking. stdout, JSON lines, one `write` each:

```
{"ev":"ready","w":1920,"h":720,"fps":30.000}     once per (re)init, when its first frame is shown
{"ev":"stats","decoded":N,"shown":N,"dropped":N,"queue":N,"decode_ms":x,"cpu_pct":x,"fps":x,"held":N}   every 2 s
{"ev":"error","msg":"..."}                        once per reset, and before exit 1/2
{"ev":"eof"}                                      stdin closed, then exit 0
```

- `decoded`, `shown`, `dropped`: totals. `dropped` = decoded frames never shown
  (cut from a burst, or discarded by a new sequence). `queue`: decoded frames
  waiting. `decode_ms`: mean time of one access unit's decode (incl. the GPU
  copy to system memory) over the last 2 s. `cpu_pct`: this process, all
  threads, % of one core. `fps`: frames shown a second over the last 2 s.
  `held`: ticks with nothing to
  show since start (underruns).
- `fps` in `ready`: the SPS VUI `time_scale / (2 * num_units_in_tick)` (x264
  writes 60/1 for 30 fps, which ffprobe shows as `r_frame_rate 60/1`); 30 when
  the SPS has no timing info (logged).

Exit codes: 0 stdin EOF, 1 decoder init failed (render node, VA, MSDK
session), 2 bad arguments or the MGVF file cannot be created (also later,
when a new sequence needs a new size), 70 fatal signal or `std::terminate`
(`PR_SET_DUMPABLE 0`, `RLIMIT_CORE 0`, one line on a `sigaltstack`,
`_exit(70)`; built `-DNDEBUG`).

## How it works

Two threads. **Main (decode) thread**: `read(0)` 64 KiB at a time →
`Feeder` (NalReader framing) → access units → `Decoder::feed` → each frame
goes into a queue of at most 4 decoded frames (a burst keeps the newest 4).
All MSDK calls are on this thread. **Present thread**: `Pacer` ticks at the
SPS period; per tick it takes the oldest frame, deinterleaves it straight
into the next MGVF slot and publishes it. It touches only synced
system-memory frames.

- Start: nothing is decoded until one access unit carries SPS + PPS + IDR.
  A new SPS (bytes differ from the running one) or a decode error: the
  decoder is reset, queued frames of the old sequence are discarded, and the
  next IDR (with SPS + PPS) starts again. The MGVF file is only re-created
  when the size changes, so the last good frame stays on screen meanwhile.
  The same SPS repeated before every IDR changes nothing.
- Pacing (`src/pacer.h`): the first frame of a sequence is shown at once and
  the first tick is put 2 periods later (buffer ~2 deep). At a tick: > 4
  queued → drop the oldest down to 4; empty → hold (nothing written, nothing
  decoded twice) and keep the tick grid, so a late frame waits for the next
  tick (the buffer grows by one: that is the adaptation); 4 queued (more than
  one frame over the target) → the next tick comes after 3/4 of a period
  (latency over pacing); a tick missed by more than a period re-anchors.
- Memory traffic per frame (1920x720 = 2.07 MB NV12): GPU copy into system
  memory; one CPU pass reading it and writing I420 into the MGVF slot with
  non-temporal stores (no read-for-ownership; `sfence` before the slot/seq
  release); mgu-render reads the slot. No VPP pass, no intermediate buffer.
- Corrupted frames (MSDK `Corrupted` flags, concealed) are shown, like ytdec and
  mgu-moonlight; the first one per run is logged. Over TCP there is no loss.
- Latency budget: framing 1 frame (NalReader knows an access unit is complete
  only when the next one's first bytes arrive) + decode + ~1-2 frames of
  jitter buffer. The framing frame could go if the server wrote an access
  unit delimiter (`00 00 00 01 09 f0`) right after each frame (not done:
  server change).

## Tests

- Unit tests (`test/camdec_test.cpp`, host and x86_64): SPS parser on the live
  server's SPS (1920x720, 60/2 = 30 fps, BT.709 limited) and ffmpeg/x264 ones
  (1080 cropped from 1088 at 24 fps, 1280x720 20 fps, 640x360 with `cqm=jvt`
  scaling lists 25 fps); feeder with chunks of 1 byte and random 1..23 bytes
  (wait for SPS+PPS+IDR, same SPS repeated, new SPS without IDR waits, new SPS
  with IDR restarts, resync after an error); pacer on a fake clock (steady
  cadence ±0.1 ms, hold when empty on the grid, drop above 4, 3/4 period
  catch-up, re-anchor, restart); NV12→I420 vs the reference (15 widths
  incl. odd chroma widths, 3 pitches, 3 destination alignments, bytes around
  the frame untouched); MGVF header (BT.709 = matrix 1, range 0, sizes,
  slot 1,2,0,1.. order, seq, slot content, re-creation on a new size).
- Smoke test (`tools/smoke.py`, host binary with `test/fake_decoder.h`):
  an ffmpeg/x264 test file and a jap-cams server capture fed at 30 fps in random
  chunks (`tools/feed.py`): steady, jitter 0..25 ms + 500 ms stall (burst cut
  down to 4), a decode error at AU 40 (error, ready again at the next IDR), a
  new SPS mid-stream (1280x720 20 fps: ready again, MGVF re-created), exit 2
  for bad arguments and an MGVF that cannot be created.
- `make target`: loader `/lib/ld-linux-x86-64.so.2`, GLIBC ≤ 2.17,
  GLIBCXX ≤ 3.4.22 (unit: 2.27, 3.4.24), 14 MSDK/VA imports all exported by
  the unit's libraries.

## On the car

Not measured on a car yet: `decode_ms`, the CPU cost of the deinterleave, the surface count (suggested + 6
held, ~2 MB each at 1920x720) and whether `GPUCopy ON` covers the decoder's copy to system memory. The `stats`
lines in the service's log give them.

## Possible later work

NV12 MGVF, dmabuf zero-copy, HEVC. Also: when `w % 16 == 0`
and nothing is cropped at the bottom, the Y plane could be decoded straight
into an MGVF slot and only UV deinterleaved, but that ties the queue depth to
the 3 slots (a protocol change, not a drop-in).
