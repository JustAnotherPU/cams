// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* Host stand-in for woc::Decoder (MSDK cannot run on the Mac): same calls.
 * One frame per access unit with a slice, sized by the last SPS, Y = frame
 * number & 0xff, UV = 128, pitch rounded to 64 like the MSDK surfaces.
 * CAMDEC_FAKE_FAIL=N: the Nth access unit fed (1-based) fails to decode. */
#ifndef CAMDEC_FAKE_DECODER_H
#define CAMDEC_FAKE_DECODER_H

#include "decoder_msdk.h"
#include "feeder.h"

#include <stdlib.h>
#include <string.h>

#include <vector>

namespace camdec {

class FakeDecoder {
public:
    using FrameSink = woc::Decoder::FrameSink;

    bool init(const char *, std::string *)
    {
        const char *f = getenv("CAMDEC_FAKE_FAIL");
        fail_at_ = f ? strtoull(f, nullptr, 10) : 0;
        return true;
    }
    bool feed(const uint8_t *au, size_t len, const FrameSink &cb, std::string *err)
    {
        if (++fed_ == fail_at_) {
            *err = "fake decode error";
            return false;
        }
        bool vcl = false;
        for (size_t i = 0; i + 4 < len; i++) {
            if (!(au[i] == 0 && au[i + 1] == 0 && au[i + 2] == 1))
                continue;
            const unsigned t = au[i + 3] & 0x1f;
            if (t == 7) {
                size_t j = i + 3;
                while (j + 3 <= len && !(au[j] == 0 && au[j + 1] == 0 && au[j + 2] == 1))
                    j++;
                if (parse_sps(au + i + 3, (j + 3 <= len ? j - 1 : len) - (i + 3), &sps_))
                    running_ = true;
            }
            vcl |= t == 1 || t == 5;
            i += 2;
        }
        if (!running_ || !vcl)
            return true;
        const uint32_t pitch = (sps_.w + 63) & ~63u;
        std::shared_ptr<std::vector<uint8_t>> mem(new std::vector<uint8_t>((size_t)pitch * sps_.h * 3 / 2, 128));
        memset(mem->data(), (int)(frames_++ & 0xff), (size_t)pitch * sps_.h);
        woc::VideoFrame f;
        f.w = sps_.w, f.h = sps_.h, f.corrupted = 0, f.pitch = pitch;
        f.y = mem->data();
        f.uv = mem->data() + (size_t)pitch * sps_.h;
        f.hold = mem;
        cb(f);
        return true;
    }
    void reset() { running_ = false; }
    void shutdown() {}

private:
    Sps sps_;
    bool running_ = false;
    uint64_t fed_ = 0, fail_at_ = 0, frames_ = 0;
};

}  // namespace camdec

#endif
