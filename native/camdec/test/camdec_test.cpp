// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* camdec unit tests: SPS parser, live feeder, pacer, NV12->I420, MGVF.
 * Build: make test (host) and make target (x86_64 in Docker, where the SSE2
 * converter is the one compared with the reference). */
#include "feeder.h"
#include "mgvf.h"
#include "pacer.h"

#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <string>
#include <vector>

using namespace camdec;

static int g_fail = 0, g_checks = 0;
#define CHECK(c)                                                         \
    do {                                                                 \
        g_checks++;                                                      \
        if (!(c)) {                                                      \
            g_fail++;                                                    \
            fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #c); \
        }                                                                \
    } while (0)

static std::vector<uint8_t> hex(const char *h)
{
    std::vector<uint8_t> v;
    for (; h[0] && h[1]; h += 2) {
        unsigned b;
        sscanf(h, "%2x", &b);
        v.push_back((uint8_t)b);
    }
    return v;
}

/* SPS of the RideWatch server's streams (cam1.h264 and mosaic.h264, the same
 * bytes): x264 High, 1920x720, VUI num_units_in_tick 1, time_scale 60. */
static const char kSpsCam[] = "67640028acb603c02dd80b50101014000003000400000300f23c60cb80";
static const char kPpsCam[] = "68eac1bcb0";
/* ffmpeg/libx264 testsrc2: 1920x1080 (1088 cropped) 24 fps; 1280x720 20 fps;
 * 640x360 25 fps with cqm=jvt (scaling matrices); 1920x720 30 fps. */
static const char kSps1080[] = "67640028acb200f0044fcb80880000030008000003018078c19240";
static const char kSps720p20[] = "6764001facb200a00b760220000003002000000501e30649";
static const char kSpsJvt[] = "6764001eacb201405ff2e022000003000200000300641e2c5c90";
static const char kSpsX264[] = "67640028acb200f00b760220000003002000000781e30649";

static void test_sps()
{
    struct {
        const char *hex;
        uint32_t w, h;
        double fps;
    } cases[] = {
        {kSpsCam, 1920, 720, 30.0}, {kSps1080, 1920, 1080, 24.0}, {kSps720p20, 1280, 720, 20.0},
        {kSpsJvt, 640, 360, 25.0},  {kSpsX264, 1920, 720, 30.0},
    };
    for (auto &c : cases) {
        const std::vector<uint8_t> s = hex(c.hex);
        Sps sps;
        CHECK(parse_sps(s.data(), s.size(), &sps));
        CHECK(sps.w == c.w && sps.h == c.h);
        CHECK(sps.fps() == c.fps);
    }
    /* the live stream's own numbers: ffprobe's 60/1 is time_scale, not fps */
    const std::vector<uint8_t> s = hex(kSpsCam);
    Sps sps;
    CHECK(parse_sps(s.data(), s.size(), &sps));
    CHECK(sps.fps_num == 60 && sps.fps_den == 2);
    CHECK(!sps.full_range && sps.matrix == 1);   /* BT.709 limited, as the MGVF header says */
    CHECK(!parse_sps(s.data(), 6, &sps));        /* truncated */
}

/* A synthetic stream: NAL units behind start codes. */
struct Stream {
    std::vector<uint8_t> b;
    void nal(const std::vector<uint8_t> &n, bool four = true)
    {
        static const uint8_t sc[4] = {0, 0, 0, 1};
        b.insert(b.end(), four ? sc : sc + 1, sc + 4);
        b.insert(b.end(), n.begin(), n.end());
    }
    /* slices: first_mb_in_slice 0 (the bit after the header is 1) */
    void idr(uint8_t tag) { nal({0x65, 0x88, 0x84, tag, 0x21}); }
    void p(uint8_t tag) { nal({0x41, 0x9a, 0x02, tag, 0x11}, false); }
    void headers(const char *sps) { nal(hex(sps)), nal(hex(kPpsCam)); }
};

struct Got {
    size_t len;
    bool start;
    uint8_t tag;   /* the slice's 4th byte */
};

static std::vector<Got> feed_chunked(Feeder &f, const std::vector<uint8_t> &b, unsigned seed)
{
    std::vector<Got> got;
    srand(seed);
    size_t i = 0;
    while (i < b.size()) {
        size_t n = seed == 0 ? 1 : (size_t)(rand() % 23) + 1;   /* seed 0: byte by byte */
        n = std::min(n, b.size() - i);
        f.push(b.data() + i, n, [&](const uint8_t *au, size_t len, bool start) {
            /* the tag is in the last slice: 4 bytes before the end */
            got.push_back(Got{len, start, au[len - 2]});
        });
        i += n;
    }
    return got;
}

static void test_feeder()
{
    Stream s;
    s.p(1), s.p(2);            /* joined mid-stream: no headers yet */
    s.nal(hex(kSpsCam));       /* SPS without PPS + IDR in the same unit: not a start */
    s.p(3);
    s.headers(kSpsCam), s.idr(10), s.p(11), s.p(12);
    s.headers(kSpsCam), s.idr(20), s.p(21);   /* the same SPS again: no reset */
    s.headers(kSps720p20), s.p(30);           /* a new SPS without IDR: wait */
    s.p(31);
    s.headers(kSps720p20), s.idr(40), s.p(41);
    s.headers(kSps720p20), s.idr(50);         /* the last one waits for more bytes */

    for (unsigned seed : {0u, 1u, 2u, 3u, 77u}) {
        Feeder f;
        const std::vector<Got> got = feed_chunked(f, s.b, seed);
        const uint8_t want[] = {10, 11, 12, 20, 21, 40, 41};
        CHECK(got.size() == sizeof want);
        for (size_t i = 0; i < got.size() && i < sizeof want; i++) {
            CHECK(got[i].tag == want[i]);
            CHECK(got[i].start == (want[i] == 10 || want[i] == 40));
        }
        CHECK(f.skipped == 5);   /* p1+p2, sps+p3, p30, p31 */
        CHECK(f.sps().w == 1280 && f.sps().h == 720 && f.sps().fps() == 20.0);
    }

    /* resync after a decode error: the next P is skipped, the next IDR starts */
    Feeder f;
    Stream a;
    a.headers(kSpsCam), a.idr(1), a.p(2);
    std::vector<Got> got = feed_chunked(f, a.b, 5);
    CHECK(got.size() == 1 && got[0].start);
    f.resync();
    Stream b;
    b.p(3), b.headers(kSpsCam), b.idr(4), b.p(5);
    got = feed_chunked(f, b.b, 6);
    /* p2 (completed by b's first bytes) and p3 are dropped; p5 waits for more bytes */
    CHECK(got.size() == 1 && got[0].tag == 4 && got[0].start);
    CHECK(f.skipped == 2);
}

/* Pacer on a fake clock: period 33333 us (30 fps). */
static void test_pacer()
{
    const int64_t T = 33333;
    int64_t wake = 0;

    /* steady: one frame arrives per period; shown exactly T apart once primed */
    {
        Pacer p;
        p.restart(T);
        size_t q = 0;
        std::vector<int64_t> shown;
        int64_t next_arrival = 1000;
        for (int64_t now = 0; now < 3000000; now += 100) {   /* 0.1 ms steps */
            if (now >= next_arrival) {
                q++;
                next_arrival += T;
            }
            Pacer::Act a;
            while ((a = p.poll(now, q, &wake)) != Pacer::kWait) {
                CHECK(a == Pacer::kShow);
                q--;
                shown.push_back(now);
            }
        }
        CHECK(shown.size() >= 85);
        CHECK(shown[1] - shown[0] >= 2 * T - 100 && shown[1] - shown[0] <= 2 * T + 100);   /* primed: 2 frames */
        bool steady = true;
        for (size_t i = 2; i < shown.size(); i++)
            steady &= shown[i] - shown[i - 1] >= T - 100 && shown[i] - shown[i - 1] <= T + 100;
        CHECK(steady);
        CHECK(p.holds == 0 && p.catchups == 0);
        CHECK(q <= 2);   /* latency stays at the target */
    }

    /* hold when empty, keep the grid; the next frame waits for its tick */
    {
        Pacer p;
        p.restart(T);
        CHECK(p.poll(0, 0, &wake) == Pacer::kWait && wake == Pacer::kForever);
        CHECK(p.poll(500, 1, &wake) == Pacer::kShow);          /* first: at once */
        CHECK(p.poll(600, 0, &wake) == Pacer::kWait && wake == 500 + 2 * T);
        CHECK(p.poll(500 + 2 * T, 0, &wake) == Pacer::kWait);   /* tick, empty: hold */
        CHECK(p.holds == 1 && wake == 500 + 3 * T);
        CHECK(p.poll(500 + 2 * T + 5000, 1, &wake) == Pacer::kWait && wake == 500 + 3 * T);   /* arrived late */
        CHECK(p.poll(500 + 3 * T, 1, &wake) == Pacer::kShow);
    }

    /* catch-up: > 4 queued -> drop the oldest down to 4, show, then 3/4 periods */
    {
        Pacer p;
        p.restart(T);
        CHECK(p.poll(0, 1, &wake) == Pacer::kShow);
        size_t q = 7;
        int drops = 0;
        Pacer::Act a;
        while ((a = p.poll(2 * T, q, &wake)) == Pacer::kDrop) {
            drops++;
            q--;
        }
        CHECK(drops == 3 && q == 4 && a == Pacer::kShow);
        q--;
        CHECK(p.poll(2 * T, q, &wake) == Pacer::kWait && wake == 2 * T + T * 3 / 4);   /* q was 4: behind */
        CHECK(p.poll(wake, q, &wake) == Pacer::kShow);   /* q 3: back to one period */
        CHECK(p.poll(2 * T + T * 3 / 4, 2, &wake) == Pacer::kWait && wake == 2 * T + T * 3 / 4 + T);
        CHECK(p.catchups == 1);
    }

    /* a stalled thread re-anchors instead of bursting */
    {
        Pacer p;
        p.restart(T);
        p.poll(0, 1, &wake);
        CHECK(p.poll(10 * T, 3, &wake) == Pacer::kShow);
        CHECK(p.poll(10 * T, 2, &wake) == Pacer::kWait && wake == 11 * T);
    }

    /* restart: the next sequence's first frame shows at once */
    {
        Pacer p;
        p.restart(T);
        p.poll(0, 1, &wake);
        p.restart(50000);
        CHECK(p.poll(10, 1, &wake) == Pacer::kShow);
        CHECK(p.poll(11, 0, &wake) == Pacer::kWait && wake == 10 + 100000);
    }
}

static void test_convert()
{
    srand(42);
    const uint32_t widths[] = {16, 18, 30, 32, 34, 46, 62, 64, 66, 94, 126, 130, 1920, 1922, 2046};
    for (uint32_t w : widths) {
        for (uint32_t h : {2u, 6u, 16u}) {
            for (size_t extra : {(size_t)0, (size_t)2, (size_t)64}) {
                const size_t pitch = w + extra;
                std::vector<uint8_t> src(pitch * h * 3 / 2 + 64);
                for (auto &b : src)
                    b = (uint8_t)rand();
                const uint8_t *y = src.data(), *uv = src.data() + pitch * h;
                const size_t n = (size_t)w * h * 3 / 2;
                for (size_t off : {(size_t)0, (size_t)1, (size_t)8}) {   /* destination alignment */
                    std::vector<uint8_t> a(n + 32, 0xee), b(n + 32, 0xee);
                    nv12_to_i420(y, uv, pitch, w, h, a.data() + off);
                    nv12_fence();
                    nv12_to_i420_ref(y, uv, pitch, w, h, b.data() + off);
                    CHECK(a == b);   /* bytes outside the frame untouched too */
                }
            }
        }
    }
    /* known values: U from even bytes, V from odd */
    const uint8_t yy[4] = {1, 2, 3, 4}, uv[2] = {50, 60};
    uint8_t d[6];
    nv12_to_i420(yy, uv, 2, 2, 2, d);
    nv12_fence();
    CHECK(d[0] == 1 && d[3] == 4 && d[4] == 50 && d[5] == 60);
#if defined(__SSE2__)
    printf("converter: SSE2 path checked against the scalar reference\n");
#else
    printf("converter: no SSE2 on this host, scalar path only\n");
#endif
}

static void test_mgvf()
{
    char path[] = "/tmp/camdec_test_mgvf_XXXXXX";
    int fd = mkstemp(path);
    CHECK(fd >= 0);
    close(fd);
    Mgvf m;
    std::string err, warn;
    CHECK(!m.open(path, 17, 16, 3, &err, &warn));        /* odd */
    CHECK(!m.open(path, 2050, 16, 3, &err, &warn));      /* over 2048 */
    CHECK(m.open(path, 64, 32, 3, &err, &warn));
    const size_t fs = 64 * 32 * 3 / 2;
    auto head = [&](MgvfHead *h) {
        int f = open(path, O_RDONLY);
        CHECK(pread(f, h, sizeof *h, 0) == (ssize_t)sizeof *h);
        close(f);
    };
    MgvfHead h;
    head(&h);
    CHECK(h.magic == kMgvfMagic && h.version == 1 && h.w == 64 && h.h == 32 && h.nslot == 3);
    CHECK(h.matrix == 1 && h.full == 0);   /* BT.709 limited */
    CHECK(h.seq == 0 && h.slot == 0);
    /* slot order: 1, 2, 0, 1 ...; seq counts up; the slot holds what we wrote */
    std::vector<uint8_t> y(64 * 32, 0), uvp(64 * 16, 0);
    for (uint32_t i = 1; i <= 5; i++) {
        memset(y.data(), (int)(i * 10), y.size());
        nv12_to_i420(y.data(), uvp.data(), 64, 64, 32, m.begin());
        m.commit();
        head(&h);
        CHECK(h.seq == i && h.slot == i % 3);
        uint8_t px = 0;
        int f = open(path, O_RDONLY);
        CHECK(pread(f, &px, 1, (off_t)(sizeof(MgvfHead) + h.slot * fs)) == 1);
        close(f);
        CHECK(px == i * 10);
    }
    /* a different size re-creates the same file */
    CHECK(m.open(path, 32, 16, 3, &err, &warn));
    head(&h);
    CHECK(h.w == 32 && h.h == 16 && h.seq == 0);
    m.close();
    unlink(path);
}

int main()
{
    test_sps();
    test_feeder();
    test_pacer();
    test_convert();
    test_mgvf();
    printf("camdec_test: %d checks, %d failed\n", g_checks, g_fail);
    return g_fail ? 1 : 0;
}
