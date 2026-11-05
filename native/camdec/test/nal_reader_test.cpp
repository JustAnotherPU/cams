// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/* Host tests for the Annex-B access unit reader (no GPU).
 *
 * The streams are real encoder output, 3 frames of a flat 32x32 picture:
 *   x264_stream      ffmpeg libx264 -profile:v baseline -x264-params
 *                    slices=2:bframes=0:keyint=30:scenecut=0, SEI removed
 *                    (filter_units=remove_types=6). Two slices per picture
 *                    (first_mb_in_slice 0 and 2), 3- and 4-byte start
 *                    codes, an emulation prevention byte in the SPS.
 *   x264_aud_stream  the same with aud=1.
 *   x264_b_stream    ffmpeg libx264 -profile:v main -x264-params
 *                    bframes=1:b-adapt=0:b-pyramid=0, 4 frames, SEI removed:
 *                    I, P, B (slice_type 6, non-reference), P.
 *   vt_stream        ffmpeg h264_videotoolbox -realtime 1 -bf 0 (Apple's
 *                    encoder, as on the phone): High profile, SEI before the
 *                    IDR slice, 4-byte start codes.
 * The *_nals tables give each NAL unit's payload (offset, length), found
 * independently of the reader by searching for 00 00 01. */
#include "../src/nal_reader.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace woc;

static int failures;

#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); failures++; } } while (0)

struct Span {
    size_t off, len;
};

static const uint8_t x264_stream[118] = {
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x09, 0x6c, 0x04, 0x40, 0x00, 0x00, 0x03,
    0x00, 0x40, 0x00, 0x00, 0x0f, 0x03, 0xc4, 0x89, 0x92, 0x00, 0x00, 0x00, 0x01, 0x68, 0xcb, 0x83,
    0xcb, 0x20, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x0b, 0xf1, 0x18, 0xa0, 0x00, 0x21, 0x57, 0x1c,
    0x00, 0x04, 0x46, 0xa3, 0x80, 0x00, 0x88, 0xec, 0x9e, 0x00, 0x00, 0x01, 0x65, 0x62, 0x21, 0x02,
    0xfc, 0x46, 0x28, 0x00, 0x08, 0x55, 0xc7, 0x00, 0x01, 0x11, 0xa8, 0xe0, 0x00, 0x22, 0x3b, 0x27,
    0x80, 0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x38, 0x15, 0xee, 0x00, 0x00, 0x01, 0x41, 0x66, 0x8e,
    0x05, 0x7b, 0x80, 0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x54, 0x04, 0xfb, 0x80, 0x00, 0x00, 0x01,
    0x41, 0x66, 0x95, 0x01, 0x3e, 0xe0,
};
/* SPS, PPS, IDR slice (mb 0), IDR slice (mb 2), then P (mb 0), P (mb 2) twice. */
static const Span x264_stream_nals[] = {{4, 21}, {29, 5}, {37, 20}, {60, 21}, {85, 5}, {93, 6}, {103, 6}, {112, 6}};
static const std::vector<std::vector<int>> x264_aus = {{0, 1, 2, 3}, {4, 5}, {6, 7}};

static const uint8_t x264_aud_stream[134] = {
    0x00, 0x00, 0x00, 0x01, 0x09, 0x10, 0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xc0, 0x0a, 0xd9, 0x09,
    0x6c, 0x04, 0x40, 0x00, 0x00, 0x03, 0x00, 0x40, 0x00, 0x00, 0x0f, 0x03, 0xc4, 0x89, 0x92, 0x00,
    0x00, 0x00, 0x01, 0x68, 0xcb, 0x83, 0xcb, 0x20, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x0b, 0xf1,
    0x18, 0xa0, 0x00, 0x21, 0x57, 0x1c, 0x00, 0x04, 0x46, 0xa3, 0x80, 0x00, 0x88, 0xec, 0x9e, 0x00,
    0x00, 0x01, 0x65, 0x62, 0x21, 0x02, 0xfc, 0x46, 0x28, 0x00, 0x08, 0x55, 0xc7, 0x00, 0x01, 0x11,
    0xa8, 0xe0, 0x00, 0x22, 0x3b, 0x27, 0x80, 0x00, 0x00, 0x00, 0x01, 0x09, 0x30, 0x00, 0x00, 0x01,
    0x41, 0x9a, 0x38, 0x15, 0xee, 0x00, 0x00, 0x01, 0x41, 0x66, 0x8e, 0x05, 0x7b, 0x80, 0x00, 0x00,
    0x00, 0x01, 0x09, 0x30, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x54, 0x04, 0xfb, 0x80, 0x00, 0x00, 0x01,
    0x41, 0x66, 0x95, 0x01, 0x3e, 0xe0,
};
/* AUD, SPS, PPS, IDR, IDR, then AUD, P, P twice. */
static const Span x264_aud_stream_nals[] = {{4, 2}, {10, 21}, {35, 5}, {43, 20}, {66, 21}, {91, 2}, {96, 5}, {104, 6}, {114, 2}, {119, 6}, {128, 6}};
static const std::vector<std::vector<int>> x264_aud_aus = {{0, 1, 2, 3, 4}, {5, 6, 7}, {8, 9, 10}};

static const uint8_t vt_stream[195] = {
    0x00, 0x00, 0x00, 0x01, 0x27, 0x64, 0x00, 0x0b, 0xac, 0x56, 0x83, 0x0d, 0xe0, 0x51, 0x82, 0x14,
    0x00, 0x00, 0x00, 0x01, 0x28, 0xee, 0x3c, 0xb0, 0x00, 0x00, 0x00, 0x01, 0x06, 0x05, 0x2d, 0x47,
    0x56, 0x4a, 0xdc, 0x5c, 0x4c, 0x43, 0x3f, 0x94, 0xef, 0xc5, 0x11, 0x3c, 0xd1, 0x43, 0xa8, 0x01,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x03, 0x00, 0x00, 0x03, 0x00, 0x01, 0x02, 0x00, 0x01, 0xe6, 0x00,
    0x0b, 0x00, 0x00, 0x03, 0x00, 0x00, 0x03, 0x00, 0x00, 0x06, 0x2c, 0x0c, 0x03, 0x91, 0x2b, 0x01,
    0x80, 0x00, 0x00, 0x00, 0x01, 0x25, 0xb8, 0x20, 0x1f, 0xde, 0x08, 0xe3, 0xc6, 0xfb, 0x8a, 0x62,
    0x6e, 0x59, 0x85, 0x12, 0x4b, 0x7c, 0x36, 0x05, 0x00, 0x11, 0x27, 0xf9, 0xcb, 0x0b, 0xbc, 0xf7,
    0x9e, 0x1c, 0x64, 0x7f, 0xa1, 0xe0, 0xa3, 0x50, 0xef, 0xa2, 0xc7, 0xb3, 0x53, 0xb0, 0x17, 0xd5,
    0xc6, 0x41, 0x33, 0x90, 0x91, 0x4f, 0x85, 0x2a, 0x01, 0x04, 0xad, 0x9f, 0x6f, 0x40, 0x00, 0x04,
    0x98, 0x20, 0x01, 0x07, 0x13, 0x8a, 0xa0, 0x00, 0x00, 0x00, 0x01, 0x21, 0xe1, 0x04, 0x5f, 0x02,
    0x80, 0x2f, 0x43, 0x5c, 0x00, 0x09, 0x0a, 0x8b, 0x94, 0x16, 0x42, 0xf6, 0x00, 0x00, 0x00, 0x01,
    0x21, 0xe2, 0x08, 0x4b, 0xff, 0x01, 0xca, 0x04, 0x11, 0x13, 0x40, 0x04, 0xe6, 0x24, 0x2f, 0xed,
    0x95, 0x47, 0x80,
};
/* SPS, PPS, SEI, IDR, P, P. */
static const Span vt_stream_nals[] = {{4, 12}, {20, 4}, {28, 53}, {85, 66}, {155, 17}, {176, 19}};
static const std::vector<std::vector<int>> vt_aus = {{0, 1, 2, 3}, {4}, {5}};

static const uint8_t x264_b_stream[100] = {
    0x00, 0x00, 0x00, 0x01, 0x67, 0x4d, 0x40, 0x0a, 0xf2, 0x12, 0xd8, 0x08, 0x80, 0x00, 0x00, 0x03,
    0x00, 0x80, 0x00, 0x00, 0x1e, 0x07, 0x89, 0x12, 0x89, 0x00, 0x00, 0x00, 0x01, 0x68, 0xeb, 0xe3,
    0xcb, 0x20, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x00, 0xbf, 0xfe, 0xdb, 0x5b, 0xf3, 0x2c, 0x2f,
    0xd8, 0xab, 0x0e, 0xce, 0xfb, 0x98, 0x81, 0x2f, 0xd6, 0x76, 0x48, 0x2f, 0xc1, 0x00, 0x00, 0x00,
    0x01, 0x41, 0x9a, 0x29, 0xb1, 0x0a, 0xff, 0xfe, 0x56, 0x00, 0x00, 0x00, 0x01, 0x01, 0x9e, 0x45,
    0xe4, 0x27, 0xff, 0x63, 0x41, 0x00, 0x00, 0x00, 0x01, 0x41, 0x9a, 0x4c, 0xf0, 0x86, 0x4c, 0xa6,
    0x10, 0x9f, 0xfe, 0x4e,
};
/* SPS, PPS, IDR, P, B, P. */
static const Span x264_b_stream_nals[] = {{4, 21}, {29, 5}, {37, 24}, {65, 8}, {77, 8}, {89, 11}};
static const std::vector<std::vector<int>> x264_b_aus = {{0, 1, 2}, {3}, {4}, {5}};

typedef std::vector<uint8_t> Bytes;

struct Got {
    Bytes data;
    bool sps, idr, b;
};

struct Stream {
    Bytes bytes;
    std::vector<Bytes> nals;                  /* payloads, no start code */
    std::vector<std::vector<int>> aus;        /* NAL indices per access unit */
};

static Stream stream(const uint8_t *data, size_t len, const Span *spans, size_t n,
                     const std::vector<std::vector<int>> &aus)
{
    Stream s;
    s.bytes.assign(data, data + len);
    for (size_t i = 0; i < n; i++)
        s.nals.push_back(Bytes(data + spans[i].off, data + spans[i].off + spans[i].len));
    s.aus = aus;
    return s;
}

static void append(Bytes &b, const Bytes &x) { b.insert(b.end(), x.begin(), x.end()); }

static void append(Bytes &b, std::initializer_list<uint8_t> x) { b.insert(b.end(), x.begin(), x.end()); }

/* What the reader must deliver: each access unit's NAL units behind 4-byte start codes. */
static std::vector<Bytes> expected(const Stream &s)
{
    std::vector<Bytes> out;
    for (auto &au : s.aus) {
        Bytes b;
        for (int i : au) {
            append(b, {0, 0, 0, 1});
            append(b, s.nals[i]);
        }
        out.push_back(b);
    }
    return out;
}

/* A stream rebuilt from its NAL units with the given start code before each. */
static Bytes rebuild(const Stream &s, std::initializer_list<uint8_t> start_code)
{
    Bytes b;
    for (auto &n : s.nals) {
        append(b, start_code);
        append(b, n);
    }
    return b;
}

static NalReader::Sink collect(std::vector<Got> &out)
{
    return [&out](const AccessUnit &au) { out.push_back(Got{Bytes(au.data, au.data + au.size), au.sps, au.idr, au.b}); };
}

static std::vector<Bytes> datas(const std::vector<Got> &got)
{
    std::vector<Bytes> out;
    for (auto &g : got) out.push_back(g.data);
    return out;
}

/* Pushes `b` in chunks of the given sizes (cycled), then flushes. */
static std::vector<Got> feed_chunks(const Bytes &b, const std::vector<size_t> &sizes)
{
    NalReader r;
    std::vector<Got> got;
    auto sink = collect(got);
    size_t pos = 0, k = 0;
    while (pos < b.size()) {
        size_t n = std::min(sizes[k++ % sizes.size()], b.size() - pos);
        r.push(b.data() + pos, n, false, sink);
        pos += n;
    }
    r.flush(sink);
    return got;
}

static void test_whole_stream(const Stream &s, const char *name)
{
    std::vector<Got> got = feed_chunks(s.bytes, {s.bytes.size()});
    if (datas(got) != expected(s))
        std::printf("FAIL %s: whole stream gives %zu access units\n", name, got.size());
    CHECK(datas(got) == expected(s));
}

static void test_x264_flags(const Stream &s)
{
    std::vector<Got> got = feed_chunks(s.bytes, {s.bytes.size()});
    CHECK(got.size() == 3);
    if (got.size() == 3) {
        CHECK(got[0].sps && got[0].idr);
        CHECK(!got[1].sps && !got[1].idr);
        CHECK(!got[2].sps && !got[2].idr);
    }
}

/* Every split into two chunks, so each start code is cut at every byte. */
static void test_every_split(const Stream &s, const char *name)
{
    std::vector<Bytes> want = expected(s);
    int bad = 0;
    for (size_t k = 0; k <= s.bytes.size(); k++) {
        NalReader r;
        std::vector<Got> got;
        auto sink = collect(got);
        r.push(s.bytes.data(), k, false, sink);
        r.push(s.bytes.data() + k, s.bytes.size() - k, false, sink);
        r.flush(sink);
        if (datas(got) != want) {
            if (!bad) std::printf("FAIL %s: split at %zu\n", name, k);
            bad++;
        }
    }
    CHECK(bad == 0);
}

static void test_chunk_patterns(const Stream &s, const char *name)
{
    std::vector<Bytes> want = expected(s);
    CHECK(datas(feed_chunks(s.bytes, {1})) == want);
    CHECK(datas(feed_chunks(s.bytes, {2})) == want);
    CHECK(datas(feed_chunks(s.bytes, {3})) == want);
    CHECK(datas(feed_chunks(s.bytes, {5, 1, 7, 2})) == want);
    uint32_t seed = 12345;
    int bad = 0;
    for (int run = 0; run < 500; run++) {
        std::vector<size_t> sizes;
        for (int i = 0; i < 64; i++) {
            seed = seed * 1103515245u + 12345u;
            sizes.push_back(1 + (seed >> 16) % 9);
        }
        if (datas(feed_chunks(s.bytes, sizes)) != want) {
            if (!bad) std::printf("FAIL %s: random chunking run %d\n", name, run);
            bad++;
        }
    }
    CHECK(bad == 0);
}

/* Without end_of_au an access unit is delivered once the first two bytes of
 * the next one's first NAL unit have arrived. */
static void test_delivery_point(const Stream &x264, const Stream &vt)
{
    /* x264_stream: the P slice (mb 0) at 85 starts access unit 1; the P
     * slice at 103 starts access unit 2. */
    const Bytes &b = x264.bytes;
    NalReader r;
    std::vector<Got> got;
    auto sink = collect(got);
    r.push(b.data(), 86, false, sink);
    CHECK(got.empty());          /* only the slice's header byte */
    r.push(b.data() + 86, 1, false, sink);
    CHECK(got.size() == 1);      /* its first_mb_in_slice bit */
    r.push(b.data() + 87, 17, false, sink);
    CHECK(got.size() == 1);
    r.push(b.data() + 104, b.size() - 104, false, sink);
    CHECK(got.size() == 2);      /* the last access unit may still get slices */
    r.flush(sink);
    CHECK(got.size() == 3);
    CHECK(datas(got) == expected(x264));

    /* videotoolbox: one slice per picture, at 85, 155 and 176. */
    const Bytes &v = vt.bytes;
    NalReader r2;
    std::vector<Got> got2;
    auto sink2 = collect(got2);
    r2.push(v.data(), 156, false, sink2);
    CHECK(got2.empty());
    r2.push(v.data() + 156, 21, false, sink2);
    CHECK(got2.size() == 1);
    r2.push(v.data() + 177, 1, false, sink2);
    CHECK(got2.size() == 2);
    r2.push(v.data() + 178, v.size() - 178, false, sink2);
    r2.flush(sink2);
    CHECK(datas(got2) == expected(vt));
}

/* Chunk boundaries at the first start code of each access unit. */
static std::vector<Bytes> frames(const Stream &s, const Span *spans)
{
    std::vector<Bytes> out;
    for (size_t a = 0; a < s.aus.size(); a++) {
        size_t from = a == 0 ? 0 : spans[s.aus[a][0]].off - 3;
        size_t to = a + 1 < s.aus.size() ? spans[s.aus[a + 1][0]].off - 3 : s.bytes.size();
        out.push_back(Bytes(s.bytes.begin() + from, s.bytes.begin() + to));
    }
    return out;
}

static void test_end_of_au(const Stream &s, const Span *spans, const char *name)
{
    std::vector<Bytes> want = expected(s);
    std::vector<Bytes> f = frames(s, spans);
    NalReader r;
    std::vector<Got> got;
    auto sink = collect(got);
    bool ok = true;
    for (size_t a = 0; a < f.size(); a++) {
        r.push(f[a].data(), f[a].size(), true, sink);
        ok = ok && got.size() == a + 1 && got[a].data == want[a];
    }
    if (!ok) std::printf("FAIL %s: end_of_au delivery\n", name);
    CHECK(ok);
    r.flush(sink);
    CHECK(got.size() == f.size());

    /* A frame split in two, the second half marked end_of_au. */
    NalReader r2;
    std::vector<Got> got2;
    auto sink2 = collect(got2);
    for (auto &fr : f) {
        size_t half = fr.size() / 2;
        r2.push(fr.data(), half, false, sink2);
        r2.push(fr.data() + half, fr.size() - half, true, sink2);
    }
    CHECK(datas(got2) == want);
}

/* SPS and PPS pushed on their own as one end_of_au chunk, then the IDR frame. */
static void test_parameter_sets_alone(const Stream &s)
{
    Bytes ps, idr;
    append(ps, {0, 0, 0, 1}); append(ps, s.nals[0]);
    append(ps, {0, 0, 0, 1}); append(ps, s.nals[1]);
    append(idr, {0, 0, 0, 1}); append(idr, s.nals[2]);
    append(idr, {0, 0, 1}); append(idr, s.nals[3]);

    NalReader r;
    std::vector<Got> got;
    auto sink = collect(got);
    r.push(ps.data(), ps.size(), true, sink);
    CHECK(got.empty());
    r.push(idr.data(), idr.size(), true, sink);
    CHECK(got.size() == 1);
    if (got.size() == 1) {
        CHECK(got[0].data == expected(s)[0]);
        CHECK(got[0].sps && got[0].idr);
    }
}

static void test_start_code_forms(const Stream &s, const char *name)
{
    std::vector<Bytes> want = expected(s);
    Bytes three = rebuild(s, {0, 0, 1});
    Bytes four = rebuild(s, {0, 0, 0, 1});
    /* trailing_zero_8bits after each NAL unit (H.264 B.1.1). */
    Bytes padded = rebuild(s, {0, 0, 0, 0, 0, 1});
    if (datas(feed_chunks(three, {three.size()})) != want) std::printf("FAIL %s: 3-byte start codes\n", name);
    CHECK(datas(feed_chunks(three, {three.size()})) == want);
    CHECK(datas(feed_chunks(three, {1})) == want);
    CHECK(datas(feed_chunks(four, {four.size()})) == want);
    CHECK(datas(feed_chunks(four, {1})) == want);
    CHECK(datas(feed_chunks(padded, {padded.size()})) == want);
    CHECK(datas(feed_chunks(padded, {1})) == want);

    /* Trailing zeros at the end of the stream, and of an end_of_au chunk. */
    Bytes tail = four;
    append(tail, {0, 0, 0});
    CHECK(datas(feed_chunks(tail, {tail.size()})) == want);
    NalReader r;
    std::vector<Got> got;
    r.push(tail.data(), tail.size(), true, collect(got));
    CHECK(datas(got) == want);
}

static void test_leading_garbage(const Stream &s)
{
    Bytes b;
    append(b, {0xff, 0x12, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00});
    append(b, s.bytes);
    CHECK(datas(feed_chunks(b, {b.size()})) == expected(s));
    CHECK(datas(feed_chunks(b, {1})) == expected(s));
}

static void test_aud(const Stream &s)
{
    std::vector<Got> got = feed_chunks(s.bytes, {s.bytes.size()});
    CHECK(datas(got) == expected(s));
    for (auto &g : got)
        CHECK(g.data.size() > 4 && (g.data[4] & 0x1f) == 9);
}

/* An SEI after a picture starts the next access unit; end of sequence (10)
 * and filler data (12) after a picture stay in its access unit. */
static void test_nal_types(const Stream &s)
{
    const Bytes sei = {0x06, 0x06, 0x01, 0xc4, 0x80};   /* recovery point SEI */
    const Bytes eos = {0x0a};
    const Bytes filler = {0x0c, 0xff, 0xff, 0x80};
    Bytes b;
    for (int i = 0; i < 4; i++) { append(b, {0, 0, 0, 1}); append(b, s.nals[i]); }
    append(b, {0, 0, 1}); append(b, filler);
    append(b, {0, 0, 1}); append(b, sei);
    for (int i = 4; i < 6; i++) { append(b, {0, 0, 1}); append(b, s.nals[i]); }
    append(b, {0, 0, 1}); append(b, eos);
    for (int i = 6; i < 8; i++) { append(b, {0, 0, 1}); append(b, s.nals[i]); }

    std::vector<Bytes> want = expected(s);
    append(want[0], {0, 0, 0, 1}); append(want[0], filler);
    Bytes au1 = {0, 0, 0, 1};
    append(au1, sei);
    append(au1, want[1]);
    want[1] = au1;
    append(want[1], {0, 0, 0, 1}); append(want[1], eos);

    CHECK(datas(feed_chunks(b, {b.size()})) == want);
    CHECK(datas(feed_chunks(b, {1})) == want);
}

static void test_b_slices(const Stream &s)
{
    std::vector<Got> got = feed_chunks(s.bytes, {s.bytes.size()});
    CHECK(datas(got) == expected(s));
    CHECK(got.size() == 4);
    if (got.size() == 4) {
        CHECK(got[0].sps && got[0].idr && !got[0].b);
        CHECK(!got[1].b);
        CHECK(got[2].b && !got[2].idr);
        CHECK(!got[3].b);
    }
}

/* Slice headers read past emulation prevention bytes: first_mb_in_slice
 * 4194303 (22 leading zero bits) puts 00 00 03 in front of the header's
 * third byte. Payloads built from the RBSP by inserting 03 after 00 00:
 *   B: rbsp 00 00 02 00 00 01 e0 (slice_type 6)
 *   P: rbsp 00 00 02 00 00 06    (slice_type 0)
 * Read without skipping the 03 bytes, the first would not be a B slice. */
static void test_emulation_prevention(const Stream &s)
{
    const Bytes b_slice = {0x01, 0x00, 0x00, 0x03, 0x02, 0x00, 0x00, 0x03, 0x01, 0xe0};
    const Bytes p_slice = {0x01, 0x00, 0x00, 0x03, 0x02, 0x00, 0x00, 0x06};
    for (int with_b = 0; with_b < 2; with_b++) {
        Bytes b;
        for (int i = 0; i < 4; i++) { append(b, {0, 0, 0, 1}); append(b, s.nals[i]); }
        append(b, {0, 0, 1});
        append(b, with_b ? b_slice : p_slice);
        std::vector<Got> got = feed_chunks(b, {b.size()});
        /* first_mb_in_slice is not 0, so the slice joins the IDR picture. */
        CHECK(got.size() == 1);
        if (got.size() == 1)
            CHECK(got[0].b == (with_b == 1));
    }
}

/* A slice NAL unit with only its header is not taken as a new picture. */
static void test_header_only_slice()
{
    const Bytes b = {0, 0, 1, 0x65, 0x88, 0x80, 0, 0, 1, 0x65, 0, 0, 1, 0x41, 0x9a, 0x80};
    std::vector<Got> got = feed_chunks(b, {b.size()});
    CHECK(got.size() == 2);
    if (got.size() == 2)
        CHECK(got[0].data == Bytes({0, 0, 0, 1, 0x65, 0x88, 0x80, 0, 0, 0, 1, 0x65}));
}

static void test_empty()
{
    NalReader r;
    std::vector<Got> got;
    auto sink = collect(got);
    r.flush(sink);
    r.push(nullptr, 0, false, sink);
    r.push(nullptr, 0, true, sink);
    const Bytes junk = {1, 2, 3, 0, 0, 2, 0, 0};
    r.push(junk.data(), junk.size(), false, sink);
    r.flush(sink);
    r.push(junk.data(), junk.size(), true, sink);
    CHECK(got.empty());

    /* Parameter sets with no slice never make an access unit. */
    const Bytes ps = {0, 0, 0, 1, 0x67, 0x42, 0x80, 0, 0, 1, 0x68, 0xce, 0x80};
    r.push(ps.data(), ps.size(), false, sink);
    r.flush(sink);
    CHECK(got.empty());
}

/* After reset the reader drops what it held. */
static void test_reset(const Stream &s)
{
    NalReader r;
    std::vector<Got> got;
    auto sink = collect(got);
    r.push(s.bytes.data(), 50, false, sink);
    r.reset();
    r.push(s.bytes.data(), s.bytes.size(), false, sink);
    r.flush(sink);
    CHECK(datas(got) == expected(s));
}

int main()
{
    Stream x264 = stream(x264_stream, sizeof x264_stream, x264_stream_nals,
                         sizeof x264_stream_nals / sizeof x264_stream_nals[0], x264_aus);
    Stream x264_aud = stream(x264_aud_stream, sizeof x264_aud_stream, x264_aud_stream_nals,
                             sizeof x264_aud_stream_nals / sizeof x264_aud_stream_nals[0], x264_aud_aus);
    Stream vt = stream(vt_stream, sizeof vt_stream, vt_stream_nals,
                       sizeof vt_stream_nals / sizeof vt_stream_nals[0], vt_aus);
    Stream x264_b = stream(x264_b_stream, sizeof x264_b_stream, x264_b_stream_nals,
                           sizeof x264_b_stream_nals / sizeof x264_b_stream_nals[0], x264_b_aus);
    const struct { const Stream *s; const Span *spans; const char *name; } all[] = {
        {&x264, x264_stream_nals, "x264"},
        {&x264_aud, x264_aud_stream_nals, "x264_aud"},
        {&vt, vt_stream_nals, "videotoolbox"},
        {&x264_b, x264_b_stream_nals, "x264_b"},
    };

    for (auto &t : all) {
        test_whole_stream(*t.s, t.name);
        test_every_split(*t.s, t.name);
        test_chunk_patterns(*t.s, t.name);
        test_end_of_au(*t.s, t.spans, t.name);
        test_start_code_forms(*t.s, t.name);
        test_leading_garbage(*t.s);
    }
    test_x264_flags(x264);
    test_delivery_point(x264, vt);
    test_parameter_sets_alone(x264);
    test_aud(x264_aud);
    test_nal_types(x264);
    test_b_slices(x264_b);
    test_emulation_prevention(x264);
    test_header_only_slice();
    test_empty();
    test_reset(x264);

    std::vector<Got> got = feed_chunks(vt.bytes, {vt.bytes.size()});
    CHECK(got.size() == 3 && got[0].sps && got[0].idr && !got[1].sps && !got[2].idr);
    for (auto &g : feed_chunks(x264.bytes, {x264.bytes.size()}))
        CHECK(!g.b);

    if (failures) {
        std::printf("%d failures\n", failures);
        return 1;
    }
    std::printf("nal_reader_test: all passed\n");
    return 0;
}
