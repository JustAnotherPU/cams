// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* camdec: live H.264 from stdin -> mgu-render's MGVF video file (README.md).
 *
 *   camdec --out /dev/shm/jap-video-ridewatch [--log FILE]
 *
 * Two threads. The main thread reads stdin, frames access units (feeder.h)
 * and decodes them on the GPU as they arrive (decoder_msdk.h: no VPP, NV12 in
 * system memory); decoded frames go into a small queue. The present thread
 * ticks at the SPS frame rate (pacer.h) and, per tick, deinterleaves the
 * oldest queued frame straight into the next MGVF slot and publishes it. All
 * MSDK calls stay on the main thread; the present thread only reads synced
 * system-memory frames.
 *
 * A core dump reboots the head unit: dumping is off before anything else,
 * and every fatal signal writes one log line and _exit(70)s. */
#include "feeder.h"
#include "mgvf.h"
#include "pacer.h"
#ifdef CAMDEC_FAKE
#include "fake_decoder.h"
#else
#include "decoder_msdk.h"
#endif

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <exception>
#include <mutex>
#include <string>
#include <thread>

#ifndef CAMDEC_VERSION
#define CAMDEC_VERSION "dev"
#endif

namespace {

#ifdef CAMDEC_FAKE
using Decoder = camdec::FakeDecoder;
#else
using Decoder = woc::Decoder;
#endif

int g_log = 2;   /* log fd; stderr until --log opens */
const int kNslot = 3;
const int64_t kStatsUs = 2000000;

int64_t mono_us()
{
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (int64_t)t.tv_sec * 1000000 + t.tv_nsec / 1000;
}

void log_line(const std::string &msg)
{
    char ts[40];
    struct timespec t;
    clock_gettime(CLOCK_REALTIME, &t);
    struct tm tm;
    localtime_r(&t.tv_sec, &tm);
    size_t n = strftime(ts, sizeof ts, "%Y-%m-%d %H:%M:%S", &tm);
    snprintf(ts + n, sizeof ts - n, ".%03ld ", t.tv_nsec / 1000000);
    std::string l = ts + msg + "\n";
    if (write(g_log, l.data(), l.size()) < 0) {
    }
}

/* stdout is a pipe to jap-ridewatch daemon: one write per line (< PIPE_BUF, so lines from
 * both threads never interleave), never buffered. */
void emit(const std::string &json)
{
    std::string l = json + "\n";
    if (write(1, l.data(), l.size()) < 0 && errno == EPIPE)
        _exit(0);
}

void emit_error(const std::string &msg)
{
    std::string m = msg;
    for (auto &c : m)
        if (c == '"' || c == '\\' || (unsigned char)c < 0x20) c = '\'';
    emit("{\"ev\":\"error\",\"msg\":\"" + m + "\"}");
    log_line("error: " + msg);
}

/* async-signal-safe: one line, then out, never a core */
void on_fatal(int sig)
{
    char b[64] = "camdec: fatal signal ";
    size_t n = strlen(b);
    if (sig >= 10) b[n++] = (char)('0' + sig / 10);
    b[n++] = (char)('0' + sig % 10);
    b[n++] = '\n';
    if (write(g_log, b, n) < 0) {
    }
    if (g_log != 2 && write(2, b, n) < 0) {
    }
    _exit(70);
}

void crash_hygiene()
{
#ifdef __linux__
    prctl(PR_SET_DUMPABLE, 0);
#endif
    struct rlimit no_core = {0, 0};
    setrlimit(RLIMIT_CORE, &no_core);
    static char altstack[64 * 1024];
    stack_t ss;
    memset(&ss, 0, sizeof ss);
    ss.ss_sp = altstack;
    ss.ss_size = sizeof altstack;
    sigaltstack(&ss, nullptr);
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_fatal;
    sa.sa_flags = SA_ONSTACK | SA_RESETHAND;
    sigemptyset(&sa.sa_mask);
    const int sigs[] = {SIGSEGV, SIGBUS, SIGFPE, SIGILL, SIGABRT, SIGQUIT, SIGTRAP, SIGSYS};
    for (int s : sigs)
        sigaction(s, &sa, nullptr);
    std::set_terminate([] {
        static const char m[] = "camdec: std::terminate\n";
        if (write(g_log, m, sizeof m - 1) < 0) {
        }
        _exit(70);
    });
    signal(SIGPIPE, SIG_IGN);
}

/* this process's CPU (all threads) since the last call, % of one core */
double cpu_pct()
{
    static int64_t last_wall = 0;
    static double last_cpu = 0;
    struct rusage ru;
    getrusage(RUSAGE_SELF, &ru);
    const double cpu = ru.ru_utime.tv_sec + ru.ru_utime.tv_usec / 1e6 + ru.ru_stime.tv_sec + ru.ru_stime.tv_usec / 1e6;
    const int64_t wall = mono_us();
    double pct = last_wall && wall > last_wall ? 100.0 * (cpu - last_cpu) * 1e6 / (double)(wall - last_wall) : 0.0;
    last_wall = wall, last_cpu = cpu;
    return pct;
}

std::string fmt(double v, int digits)
{
    char b[32];
    snprintf(b, sizeof b, "%.*f", digits, v);
    return b;
}

struct Item {
    woc::VideoFrame f;
    bool first;        /* first frame of a sequence: restart the pacer */
    bool announce;     /* emit ready when shown */
    camdec::Sps sps;
};

/* State shared by the two threads; everything under `m`. */
struct Shared {
    std::mutex m;
    std::condition_variable cv;
    std::deque<Item> q;
    bool quit = false;
    uint64_t decoded = 0, dropped = 0;
    int64_t decode_us = 0;   /* decode time summed since the last stats */
    uint64_t decode_n = 0;

    /* main thread, under m: a frame out of the decoder */
    void push(Item it)
    {
        q.push_back(std::move(it));
        decoded++;
        while (q.size() > camdec::Pacer::kMax) {   /* a burst: keep the newest */
            const bool first = q.front().first;
            q.pop_front();
            dropped++;
            q.front().first |= first;
        }
    }
};

class Presenter {
public:
    Presenter(Shared *sh, const std::string &out) : sh_(sh), out_path_(out) {}

    void run()
    {
        std::unique_lock<std::mutex> lk(sh_->m);
        int64_t next_stats = mono_us() + kStatsUs;
        while (!sh_->quit) {
            const int64_t now = mono_us();
            if (now >= next_stats) {
                stats(now);
                next_stats = std::max(next_stats + kStatsUs, now);
            }
            if (!sh_->q.empty() && sh_->q.front().first) {
                Item &f = sh_->q.front();
                f.first = false;
                f.announce = true;
                const double fps = f.sps.fps();
                if (!(fps > 0))
                    log_line("SPS has no VUI frame rate: pacing at 30 fps");
                pacer_.restart(fps > 0 ? (int64_t)(1e6 / fps + 0.5) : 33333);
            }
            int64_t wake = camdec::Pacer::kForever;
            const camdec::Pacer::Act a = pacer_.poll(now, sh_->q.size(), &wake);
            if (a == camdec::Pacer::kShow) {
                Item it = std::move(sh_->q.front());
                sh_->q.pop_front();
                lk.unlock();
                show(it);
                it.f.hold.reset();   /* back to the decoder */
                lk.lock();
            } else if (a == camdec::Pacer::kDrop) {
                sh_->q.pop_front();
                sh_->dropped++;
            } else {
                const int64_t until = std::min(wake, next_stats);
                sh_->cv.wait_for(lk, std::chrono::microseconds(std::max<int64_t>(until - now, 0)));
            }
        }
    }

private:
    void show(const Item &it)
    {
        const woc::VideoFrame &f = it.f;
        if (!out_.is_open() || f.w != out_.w() || f.h != out_.h()) {
            std::string err, warn;
            if (!out_.open(out_path_.c_str(), f.w, f.h, kNslot, &err, &warn)) {
                emit_error("MGVF " + std::to_string(f.w) + "x" + std::to_string(f.h) + ": " + err);
                _exit(2);
            }
            if (!warn.empty())
                log_line(warn);
            log_line("MGVF " + out_path_ + " " + std::to_string(f.w) + "x" + std::to_string(f.h));
        }
        if (it.announce) {
            const double fps = it.sps.fps() > 0 ? it.sps.fps() : 30.0;
            emit("{\"ev\":\"ready\",\"w\":" + std::to_string(f.w) + ",\"h\":" + std::to_string(f.h) +
                 ",\"fps\":" + fmt(fps, 3) + "}");
            log_line("ready " + std::to_string(f.w) + "x" + std::to_string(f.h) + " " + fmt(fps, 3) + " fps" +
                     (it.sps.full_range || (it.sps.matrix != 1 && it.sps.matrix != 2)
                          ? " (SPS colour is not BT.709 limited; MGVF says it is)"
                          : ""));
        }
        camdec::nv12_to_i420(f.y, f.uv, f.pitch, f.w, f.h, out_.begin());
        out_.commit();
        shown_++;
        shown_since_++;
    }

    /* under sh_->m */
    void stats(int64_t now)
    {
        const double secs = last_stats_ ? (now - last_stats_) / 1e6 : kStatsUs / 1e6;
        const double dms = sh_->decode_n ? sh_->decode_us / 1000.0 / sh_->decode_n : 0.0;
        emit("{\"ev\":\"stats\",\"decoded\":" + std::to_string(sh_->decoded) + ",\"shown\":" + std::to_string(shown_) +
             ",\"dropped\":" + std::to_string(sh_->dropped) + ",\"queue\":" + std::to_string(sh_->q.size()) +
             ",\"decode_ms\":" + fmt(dms, 2) + ",\"cpu_pct\":" + fmt(cpu_pct(), 1) +
             ",\"fps\":" + fmt(secs > 0 ? shown_since_ / secs : 0.0, 2) + ",\"held\":" + std::to_string(pacer_.holds) +
             "}");
        sh_->decode_us = 0;
        sh_->decode_n = 0;
        shown_since_ = 0;
        last_stats_ = now;
    }

    Shared *sh_;
    std::string out_path_;
    camdec::Mgvf out_;
    camdec::Pacer pacer_;
    uint64_t shown_ = 0, shown_since_ = 0;
    int64_t last_stats_ = 0;
};

const char kUsage[] = "usage: camdec --out <MGVF file> [--log <file>]";

int run(int argc, char **argv)
{
    std::string out, logpath;
    for (int i = 1; i < argc; i++) {
        const std::string a = argv[i];
        if (a == "--out" && i + 1 < argc)
            out = argv[++i];
        else if (a == "--log" && i + 1 < argc)
            logpath = argv[++i];
        else {
            emit_error(kUsage);
            return 2;
        }
    }
    if (out.empty()) {
        emit_error(kUsage);
        return 2;
    }
    if (!logpath.empty()) {
        int fd = open(logpath.c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
        if (fd >= 0)
            g_log = fd;
    }
    log_line(std::string("camdec ") + CAMDEC_VERSION + " out=" + out);

    Decoder dec;
    std::string err;
    if (!dec.init("/dev/dri/renderD128", &err)) {
        emit_error("decoder: " + err);
        return 1;
    }

    Shared sh;
    Presenter presenter(&sh, out);
    cpu_pct();
    std::thread pt([&] { presenter.run(); });

    camdec::Feeder feeder;
    bool erred = false;            /* one error event per reset */
    bool first_pending = false;    /* the next decoded frame starts a sequence */
    camdec::Sps cur;
    uint64_t corrupted = 0;
    const woc::Decoder::FrameSink sink = [&](const woc::VideoFrame &f) {
        if (f.corrupted && !corrupted++)
            log_line("decoder flags a frame corrupted (" + std::to_string(f.corrupted) + "): shown concealed");
        std::lock_guard<std::mutex> g(sh.m);
        sh.push(Item{f, first_pending, false, cur});
        first_pending = false;
        sh.cv.notify_one();
    };
    const camdec::Feeder::Sink on_au = [&](const uint8_t *au, size_t len, bool start) {
        if (start) {
            dec.reset();
            std::lock_guard<std::mutex> g(sh.m);
            sh.dropped += sh.q.size();   /* the old sequence's frames; the last shown stays on screen */
            sh.q.clear();
            first_pending = true;
            erred = false;
            cur = feeder.sps();
            log_line("sequence " + std::to_string(cur.w) + "x" + std::to_string(cur.h) + " " + fmt(cur.fps(), 3) +
                     " fps (" + std::to_string(feeder.skipped) + " access units skipped waiting)");
        }
        const int64_t t0 = mono_us();
        std::string e;
        const bool ok = dec.feed(au, len, sink, &e);
        {
            std::lock_guard<std::mutex> g(sh.m);
            sh.decode_us += mono_us() - t0;
            sh.decode_n++;
        }
        if (!ok) {
            if (!erred)
                emit_error("decode: " + e + " (waiting for the next IDR)");
            erred = true;
            dec.reset();
            feeder.resync();
        }
    };

    static uint8_t buf[64 * 1024];
    for (;;) {
        const ssize_t n = read(0, buf, sizeof buf);
        if (n < 0 && errno == EINTR)
            continue;
        if (n <= 0) {
            log_line(n == 0 ? "stdin closed" : std::string("stdin: ") + strerror(errno));
            break;
        }
        feeder.push(buf, (size_t)n, on_au);
    }
    {
        std::lock_guard<std::mutex> g(sh.m);
        sh.quit = true;
        sh.q.clear();
        sh.cv.notify_one();
    }
    pt.join();
    dec.shutdown();
    emit("{\"ev\":\"eof\"}");
    return 0;
}

}  // namespace

int main(int argc, char **argv)
{
    crash_hygiene();
    try {
        return run(argc, argv);
    } catch (const std::exception &e) {
        log_line(std::string("exception: ") + e.what());
    } catch (...) {
        log_line("unknown exception");
    }
    _exit(70);
}
