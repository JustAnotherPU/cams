// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* The live feeder: stdin bytes (any chunking) -> whole access units for the
 * decoder, gated on a decodable start.
 *
 *   - Framing by NalReader (waze-on-cluster's, unchanged). An access unit is
 *     known complete when the first bytes of the next one arrive, so framing
 *     costs one frame interval on a live stream.
 *   - Waiting: nothing goes to the decoder until an access unit carries an
 *     SPS, a PPS and an IDR slice (the server sends SPS/PPS before every IDR,
 *     and NalReader joins header-only units to the next one). Its SPS must
 *     parse (size, VUI frame rate); that access unit is delivered with
 *     start = true: the caller resets the decoder and its queue first.
 *   - Running: every access unit is delivered. One whose SPS differs, byte
 *     for byte, from the running one (a new size, rate or view) ends the
 *     sequence: back to waiting, from that very access unit when it is an IDR.
 *     A repeat of the same SPS before each IDR changes nothing.
 *   - resync(): after a decode error, back to waiting for the next IDR. */
#ifndef CAMDEC_FEEDER_H
#define CAMDEC_FEEDER_H

#include "nal_reader.h"

#include <stddef.h>
#include <stdint.h>
#include <functional>
#include <vector>

namespace camdec {

struct Sps {
    uint32_t w = 0, h = 0;               /* cropped picture size */
    uint32_t fps_num = 0, fps_den = 0;   /* VUI: time_scale, 2 * num_units_in_tick; 0 = absent */
    bool full_range = false;             /* VUI video_full_range_flag */
    uint32_t matrix = 2;                 /* VUI matrix_coefficients; 2 = unspecified */
    double fps() const { return fps_num && fps_den ? (double)fps_num / fps_den : 0.0; }
};

/* nal: one SPS NAL unit starting at its header byte (0x67), no start code. */
bool parse_sps(const uint8_t *nal, size_t len, Sps *out);

class Feeder {
public:
    /* au: one access unit, NAL units behind 4-byte start codes, valid during
     * the call. start: first access unit of a sequence (see above). */
    using Sink = std::function<void(const uint8_t *au, size_t len, bool start)>;

    void push(const uint8_t *data, size_t len, const Sink &sink);
    void resync() { running_ = false; }
    bool running() const { return running_; }
    const Sps &sps() const { return sps_; }
    uint64_t skipped = 0;   /* access units dropped while waiting */

private:
    void on_au(const woc::AccessUnit &au, const Sink &sink);

    woc::NalReader nal_;
    bool running_ = false;
    std::vector<uint8_t> sps_bytes_;
    Sps sps_;
};

}  // namespace camdec

#endif
