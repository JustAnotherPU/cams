#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""Plays an Annex-B H.264 file to stdout like the live server: one access unit
every 1/fps s (wall clock), each split into random chunks, with optional
network jitter (each frame late by 0..J ms, never reordered) and an optional
stall (nothing for S ms at frame N, then a burst).

    feed.py FILE [--fps 30] [--jitter MS] [--stall N:MS] [--seed K] [--loops L]
"""
import argparse
import random
import sys
import time


def access_units(d):
    """Split at the first NAL of each access unit (H.264 7.4.1.2.3, as NalReader)."""
    starts = []
    i = d.find(b'\x00\x00\x01')
    while i >= 0:
        starts.append(i + 3)
        i = d.find(b'\x00\x00\x01', i + 3)
    aus, cur, vcl = [], 0, False
    for s in starts:
        t = d[s] & 0x1f
        first = t in (6, 7, 8, 9) or 14 <= t <= 18 or (t in (1, 2, 5) and s + 1 < len(d) and d[s + 1] & 0x80)
        if first and vcl:
            b = s - 3
            while b > cur and d[b - 1] == 0:   # leading zero of a 4-byte start code
                b -= 1
            aus.append(d[cur:b])
            cur, vcl = b, False
        vcl = vcl or 1 <= t <= 5
    aus.append(d[cur:])
    return aus


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('file')
    ap.add_argument('--fps', type=float, default=30.0)
    ap.add_argument('--jitter', type=float, default=0.0)
    ap.add_argument('--stall', default='')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--loops', type=int, default=1)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    aus = access_units(open(a.file, 'rb').read()) * a.loops
    stall_at, stall_ms = (int(x) for x in a.stall.split(':')) if a.stall else (-1, 0)
    out = sys.stdout.buffer
    t0 = time.monotonic()
    # the server keeps encoding through a stall: everything due meanwhile comes in one burst at its end
    stall_end = t0 + stall_at / a.fps + stall_ms / 1000.0
    for n, au in enumerate(aus):
        due = t0 + n / a.fps + rnd.uniform(0, a.jitter) / 1000.0
        if 0 <= stall_at <= n:
            due = max(due, stall_end)
        d = due - time.monotonic()
        if d > 0:
            time.sleep(d)
        i = 0
        while i < len(au):
            k = rnd.randint(1, 9000)
            out.write(au[i:i + k])
            out.flush()
            i += k
    out.close()


if __name__ == '__main__':
    main()
