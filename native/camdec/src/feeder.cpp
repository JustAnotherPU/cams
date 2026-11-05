// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "feeder.h"

#include <algorithm>

namespace camdec {

namespace {

/* Bit reader over a NAL payload that skips emulation prevention bytes (a 03
 * after two zero bytes, H.264 7.4.1); nal_reader.cpp's, with u(n) and se(v). */
struct Bits {
    const uint8_t *p, *end;
    int zeros = 0;
    unsigned byte = 0;
    int left = 0;
    bool bad = false;   /* read past the end */

    Bits(const uint8_t *data, size_t len) : p(data), end(data + len) {}

    unsigned bit()
    {
        if (left == 0) {
            if (p < end && zeros >= 2 && *p == 3) {
                p++;
                zeros = 0;
            }
            if (p >= end) {
                bad = true;
                return 0;
            }
            byte = *p++;
            zeros = byte == 0 ? zeros + 1 : 0;
            left = 8;
        }
        return (byte >> --left) & 1;
    }
    uint32_t u(int n)
    {
        uint32_t v = 0;
        while (n--)
            v = v << 1 | bit();
        return v;
    }
    uint32_t ue()
    {
        int n = 0;
        while (!bit()) {
            if (bad || ++n > 31) {
                bad = true;
                return 0;
            }
        }
        return (uint32_t)((1ull << n) - 1 + u(n));
    }
    int32_t se()
    {
        const uint32_t k = ue();
        return k & 1 ? (int32_t)((k + 1) / 2) : -(int32_t)(k / 2);
    }
};

void skip_scaling_list(Bits &b, int size)
{
    int last = 8, next = 8;
    for (int j = 0; j < size && !b.bad; j++) {
        if (next != 0)
            next = (last + b.se() + 256) % 256;
        last = next == 0 ? last : next;
    }
}

}  // namespace

/* H.264 7.3.2.1.1 seq_parameter_set_data and E.1.1 vui_parameters, up to
 * timing_info. */
bool parse_sps(const uint8_t *nal, size_t len, Sps *out)
{
    if (len < 4 || (nal[0] & 0x1f) != 7)
        return false;
    Bits b(nal + 1, len - 1);
    const uint32_t profile = b.u(8);
    b.u(16);   /* constraint flags, level_idc */
    b.ue();    /* seq_parameter_set_id */
    uint32_t chroma = 1;
    if (profile == 100 || profile == 110 || profile == 122 || profile == 244 || profile == 44 || profile == 83 ||
        profile == 86 || profile == 118 || profile == 128 || profile == 138 || profile == 139 || profile == 134 ||
        profile == 135) {
        chroma = b.ue();
        if (chroma == 3)
            b.u(1);   /* separate_colour_plane_flag */
        b.ue();       /* bit_depth_luma_minus8 */
        b.ue();       /* bit_depth_chroma_minus8 */
        b.u(1);       /* qpprime_y_zero_transform_bypass_flag */
        if (b.u(1))   /* seq_scaling_matrix_present_flag */
            for (int i = 0; i < (chroma != 3 ? 8 : 12); i++)
                if (b.u(1))
                    skip_scaling_list(b, i < 6 ? 16 : 64);
    }
    if (chroma != 1)
        return false;   /* MGVF and the decoder path are 4:2:0 only */
    b.ue();   /* log2_max_frame_num_minus4 */
    const uint32_t poc_type = b.ue();
    if (poc_type == 0) {
        b.ue();
    } else if (poc_type == 1) {
        b.u(1);
        b.se();
        b.se();
        const uint32_t n = b.ue();
        for (uint32_t i = 0; i < n && !b.bad; i++)
            b.se();
    }
    b.ue();   /* max_num_ref_frames */
    b.u(1);   /* gaps_in_frame_num_value_allowed_flag */
    const uint32_t mbs_w = b.ue() + 1, map_h = b.ue() + 1;
    const uint32_t frame_mbs_only = b.u(1);
    if (!frame_mbs_only)
        b.u(1);   /* mb_adaptive_frame_field_flag */
    b.u(1);       /* direct_8x8_inference_flag */
    uint32_t cl = 0, cr = 0, ct = 0, cb = 0;
    if (b.u(1)) {
        cl = b.ue(), cr = b.ue(), ct = b.ue(), cb = b.ue();
    }
    Sps s;
    const uint32_t unit_y = 2 * (2 - frame_mbs_only);
    const uint64_t w = 16ull * mbs_w, h = 16ull * map_h * (2 - frame_mbs_only);
    if (2ull * (cl + cr) >= w || (uint64_t)unit_y * (ct + cb) >= h)
        return false;
    s.w = (uint32_t)(w - 2 * (cl + cr));
    s.h = (uint32_t)(h - unit_y * (ct + cb));
    if (b.u(1)) {                      /* vui_parameters_present_flag */
        if (b.u(1) && b.u(8) == 255)   /* aspect_ratio_info_present_flag, aspect_ratio_idc */
            b.u(32);                   /* sar_width, sar_height */
        if (b.u(1))                    /* overscan_info_present_flag */
            b.u(1);
        if (b.u(1)) {                  /* video_signal_type_present_flag */
            b.u(3);
            s.full_range = b.u(1);
            if (b.u(1)) {              /* colour_description_present_flag */
                b.u(16);               /* colour_primaries, transfer_characteristics */
                s.matrix = b.u(8);
            }
        }
        if (b.u(1)) {                  /* chroma_loc_info_present_flag */
            b.ue();
            b.ue();
        }
        if (b.u(1)) {                  /* timing_info_present_flag */
            const uint32_t units = b.u(32), scale = b.u(32);
            /* fps = time_scale / (2 * num_units_in_tick): x264 counts field
             * ticks (30 fps = 1 / 60), which is why ffprobe says 60/1 */
            if (units && scale && !b.bad) {
                s.fps_num = scale;
                s.fps_den = 2 * units;
            }
        }
    }
    if (b.bad)
        return false;
    *out = s;
    return true;
}

void Feeder::push(const uint8_t *data, size_t len, const Sink &sink)
{
    nal_.push(data, len, false, [&](const woc::AccessUnit &au) { on_au(au, sink); });
}

void Feeder::on_au(const woc::AccessUnit &au, const Sink &sink)
{
    bool pps = false, idr = false;
    const uint8_t *sps = nullptr;
    size_t sps_len = 0;
    /* NalReader writes every NAL unit behind 00 00 00 01 and none contains
     * 00 00 01, so start codes are exact boundaries. */
    const uint8_t *end = au.data + au.size;
    for (const uint8_t *p = au.data; p + 4 < end;) {
        const uint8_t *nal = p + 4, *q = nal;
        while (q + 3 <= end && !(q[0] == 0 && q[1] == 0 && q[2] == 1))
            q++;
        const uint8_t *nal_end = q + 3 <= end ? q - 1 : end;   /* the 00 before 00 00 01 */
        const unsigned type = nal[0] & 0x1f;
        if (type == 7 && !sps)
            sps = nal, sps_len = (size_t)(nal_end - nal);
        pps |= type == 8;
        idr |= type == 5;
        p = nal_end;
    }

    if (running_ && sps && (sps_len != sps_bytes_.size() || !std::equal(sps, sps + sps_len, sps_bytes_.begin())))
        running_ = false;   /* a different sequence: restart from here */

    if (!running_) {
        Sps s;
        if (!(sps && pps && idr && parse_sps(sps, sps_len, &s))) {
            skipped++;
            return;
        }
        sps_bytes_.assign(sps, sps + sps_len);
        sps_ = s;
        running_ = true;
        sink(au.data, au.size, true);
        return;
    }
    sink(au.data, au.size, false);
}

}  // namespace camdec
