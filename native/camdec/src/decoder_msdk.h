// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Modified 2026-11 by JustAnotherPU (camdec: see README.md, "Where the code comes from")
/* Hardware H.264 decoder: whole access units in, NV12 frames in system
 * memory out, in decoding order.
 *
 * camdec's copy of ytdec's decoder (RideTube native/ytdec/src/decoder_msdk.*, itself
 * waze-on-cluster's). Changes for a live camera stream that the server already
 * encodes at exactly the output size:
 *   - no VPP: the decoder writes NV12 straight into system-memory surfaces
 *     that camdec allocates (MFX_IOPATTERN_OUT_SYSTEM_MEMORY); MSDK copies
 *     its GPU surface there with the GPU (MFXInitEx GPUCopy ON, as ytdec);
 *   - decoding order (DecodedOrder 1, the server sends no B frames, like
 *     mgu-moonlight), AsyncDepth 1: each access unit gives its own frame;
 *   - a frame outlives the call: VideoFrame::hold keeps its surface out of
 *     the decoder's hands until the last copy of `hold` is gone, so a jitter
 *     buffer can queue decoded frames on another thread. The surface memory
 *     lives as long as `hold`, even across reset() and shutdown();
 *   - any failed access unit fails feed() at once (no 30-in-a-row limit):
 *     the caller resets and waits for the next IDR;
 *   - reset(): closes the sequence and its session; the next access unit
 *     with an SPS starts a new one.
 *
 * Runs on the head unit's Intel Media SDK (libmfxhw64.so, API 1.24) over
 * VA-API on a DRM render node. All calls from one thread (the decode thread);
 * a frame's planes may be read from any thread while its `hold` lives.
 *
 * UNVERIFIED (CAR-ONLY): that GPUCopy ON applies to the decoder's own copy
 * into app-allocated system surfaces (ytdec measured it for VPP output only),
 * that DecodedOrder 1 on the hardware library returns each frame from the
 * DecodeFrameAsync of its own access unit, the surface counts, throughput. */
#ifndef CAMDEC_DECODER_MSDK_H
#define CAMDEC_DECODER_MSDK_H

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <memory>
#include <string>

namespace woc {

struct VideoFrame {
    uint32_t w, h;          /* the cropped picture size */
    uint16_t corrupted;     /* MSDK's mfxFrameData::Corrupted flags; 0: decoded whole */
    const uint8_t *y, *uv;  /* NV12 planes at the crop origin, `pitch` bytes a row */
    uint32_t pitch;
    std::shared_ptr<void> hold;   /* keeps the planes valid and the surface reserved */
};

class Decoder {
public:
    using FrameSink = std::function<void(const VideoFrame &)>;
    /* Frames the caller may hold at once beyond what the decoder needs for
     * itself (camdec's queue of 4 + the frame being presented + 1). */
    static const int kHeldFrames = 6;

    Decoder();
    ~Decoder();
    Decoder(const Decoder &) = delete;
    Decoder &operator=(const Decoder &) = delete;

    /* dev: the render node, "/dev/dri/renderD128". */
    bool init(const char *dev, std::string *err);

    /* One whole access unit; cb gets the frame(s) it completes. Returns
     * false, with *err, when it failed to decode or its sequence could not
     * start, or before init(). Access units before the first SPS are dropped. */
    bool feed(const uint8_t *au, size_t len, const FrameSink &cb, std::string *err);

    /* Ends the sequence (frames already handed out stay valid). */
    void reset();

    void shutdown();

private:
    struct State;
    std::unique_ptr<State> s_;
};

}  // namespace woc

#endif
