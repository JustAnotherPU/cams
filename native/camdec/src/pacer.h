// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/* The presentation clock over the jitter buffer of decoded frames.
 *
 * poll(now, q) says what to do with q frames queued (oldest first):
 *   - first frame of a sequence (after restart): show it at once, and put the
 *     first tick kTarget periods later, so the buffer starts ~kTarget deep;
 *   - between ticks: wait;
 *   - at a tick with q > kMax: drop the oldest (again and again, down to
 *     kMax), then the tick goes on;
 *   - at a tick with q == 0: hold (no new frame: the renderer keeps the last
 *     one, nothing is decoded twice), and the tick grid goes on, so a late
 *     frame waits for the next tick instead of turning network jitter into
 *     judder: the buffer grows by one frame, which is the adaptation;
 *   - at a tick otherwise: show the oldest; the next tick is one period on,
 *     or 3/4 of one when q >= kTarget + 2 (more than one frame of extra
 *     latency: catch up rather than keep it);
 *   - a tick missed by more than a period (the thread was stalled) re-anchors
 *     the grid at now.
 * Times in microseconds, any monotonic origin. Not thread-safe. */
#ifndef CAMDEC_PACER_H
#define CAMDEC_PACER_H

#include <stddef.h>
#include <stdint.h>

namespace camdec {

class Pacer {
public:
    enum Act { kWait, kShow, kDrop };
    static const size_t kTarget = 2, kMax = 4;
    static const int64_t kForever = INT64_MAX;

    void restart(int64_t period_us)
    {
        period_ = period_us > 0 ? period_us : 33333;
        started_ = false;
    }
    int64_t period() const { return period_; }

    Act poll(int64_t now, size_t q, int64_t *wake)
    {
        if (!started_) {
            if (!q) {
                *wake = kForever;
                return kWait;
            }
            started_ = true;
            next_ = now + (int64_t)kTarget * period_;
            return kShow;
        }
        if (now < next_) {
            *wake = next_;
            return kWait;
        }
        if (q > kMax)
            return kDrop;
        if (now - next_ > period_)
            next_ = now;   /* stalled: re-anchor */
        const bool behind = q >= kTarget + 2;
        next_ += behind ? period_ * 3 / 4 : period_;
        if (!q) {
            holds++;
            *wake = next_;
            return kWait;
        }
        if (behind)
            catchups++;
        return kShow;
    }

    uint64_t holds = 0, catchups = 0;

private:
    int64_t period_ = 33333, next_ = 0;
    bool started_ = false;
};

}  // namespace camdec

#endif
