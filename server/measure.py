#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""measure a view from the jap-cams server: time to first byte / first IDR / first real picture, arrival jitter, bitrate.
usage: measure.py <host> <car code> "mosaic 1920x720" [seconds] [out.h264]     (add the code with configure.py --add-car)
picture_s: the first frame whose picture (the hero for spot) is no longer the server's flat placeholder, i.e. the
camera's own first keyframe is in (the first IDR is the placeholder's); tiles_s: [p50, max, real/all] of the same per
tile (spot, mosaic2)."""
import json, socket, statistics, subprocess, sys, time
host, tok, req = sys.argv[1:4]; secs = float(sys.argv[4]) if len(sys.argv) > 4 else 15
s = socket.create_connection((host, 18640), timeout=20); t0 = time.time(); s.sendall((tok + ' ' + req + '\n').encode())
buf = bytearray(); first = idr = None; aud = []   # arrival time of each access unit start (x264 slice NAL after SPS/PPS or AUD)
scan = 0
while time.time() - t0 < secs:
    d = s.recv(1 << 16)
    if not d: break
    now = time.time() - t0
    if first is None: first = now
    buf += d
    # count new frames: NAL type 1 or 5 with first_mb_in_slice == 0 (byte after header has MSB set)
    i = max(scan - 4, 0)
    while True:
        j = buf.find(b'\x00\x00\x01', i)
        if j < 0 or j + 4 >= len(buf): break
        t = buf[j + 3] & 0x1f
        if t in (1, 5) and buf[j + 4] & 0x80:
            aud.append(now)
            if t == 5 and idr is None: idr = now
        i = j + 3
    scan = len(buf)
s.close()
lo = None
if buf[:1] == b'{':                                  # spot / mosaic2 / cam2: the layout line first
    k = buf.index(b'\n'); lo = json.loads(buf[:k]); buf = buf[k + 1:]
if len(sys.argv) > 5: open(sys.argv[5], "wb").write(buf)


def pictures():
    """(picture_s, [tile times]): frames decoded at 1/8 size, gray; a rect is real once its stddev is over 3"""
    W, H = (int(v) for v in req.split()[-1].split('x')); w, h = W // 8, H // 8
    raw = subprocess.run(['ffmpeg', '-loglevel', 'quiet', '-f', 'h264', '-i', 'pipe:0', '-vf', 'scale=%d:%d' % (w, h),
                          '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], input=bytes(buf), capture_output=True).stdout
    frames = [raw[k:k + w * h] for k in range(0, len(raw) - w * h + 1, w * h)]
    full = {'x': 0, 'y': 0, 'w': W, 'h': H}
    rects = [(lo or {}).get('heroRect') or full] + ((lo or {}).get('tiles') or [])

    def real(f, r):
        x0, y0, x1, y1 = r['x'] // 8 + 1, r['y'] // 8 + 1, (r['x'] + r['w']) // 8 - 1, (r['y'] + r['h']) // 8 - 1
        px = [f[y * w + x] for y in range(y0, y1) for x in range(x0, x1)]
        return len(px) > 4 and statistics.pstdev(px) > 3
    out = []
    for r in rects:
        k = next((n for n, f in enumerate(frames) if real(f, r)), None)
        out.append(round(aud[k], 2) if k is not None and k < len(aud) else None)
    return out[0], out[1:]


pic, tiles = pictures()
gaps = [b - a for a, b in zip(aud, aud[1:])][30:]          # skip the start-up burst
dur = aud[-1] - aud[0] if len(aud) > 1 else 1
tt = sorted(t for t in tiles if t is not None)
print(json.dumps({'req': req, 'first_byte_s': round(first or -1, 2), 'first_idr_s': round(idr or -1, 2), 'picture_s': pic,
                  'tiles_s': [tt[len(tt) // 2] if tt else None, tt[-1] if tt else None, '%d/%d' % (len(tt), len(tiles))] if tiles else None,
                  'frames': len(aud), 'fps': round((len(aud) - 1) / dur, 1), 'kbps': round(len(buf) * 8 / 1000 / dur),
                  'gap_ms_p50': round(statistics.median(gaps) * 1000, 1) if gaps else None,
                  'gap_ms_p95': round(sorted(gaps)[int(len(gaps) * .95)] * 1000, 1) if gaps else None,
                  'gap_ms_max': round(max(gaps) * 1000, 1) if gaps else None}))
