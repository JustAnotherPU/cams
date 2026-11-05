#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""Host smoke test: real Annex-B files through the host camdec (fake decoder),
paced by feed.py like the live server. Checks the stdout contract, the exit
codes and the MGVF header.

    smoke.py CAMDEC WORKDIR MAIN.h264 [SECOND.h264 (another size)] [EXTRA.h264 ...]
"""
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
fails = 0


def check(cond, what):
    global fails
    print(('ok   ' if cond else 'FAIL ') + what)
    fails += 0 if cond else 1


def run(camdec, work, name, src_bytes, feed_args=(), env=None, args=None):
    path = os.path.join(work, name + '.in.h264')
    open(path, 'wb').write(src_bytes)
    out = os.path.join(work, name + '.mgvf')
    log = os.path.join(work, name + '.log')
    if os.path.exists(log):
        os.unlink(log)
    feed = subprocess.Popen([sys.executable, '-I', os.path.join(HERE, 'feed.py'), path] + list(feed_args),
                            stdout=subprocess.PIPE)
    try:
        p = subprocess.run([camdec] + (args if args is not None else ['--out', out, '--log', log]), stdin=feed.stdout,
                           stdout=subprocess.PIPE, env=dict(os.environ, **(env or {})), timeout=120,
                           pass_fds=())
    finally:
        feed.stdout.close()   # camdec gone -> feed.py gets EPIPE instead of blocking
        feed.kill()
        feed.wait()
    evs = [json.loads(l) for l in p.stdout.decode().splitlines() if l.strip()]
    os.unlink(path)
    return p.returncode, evs, out


def head(path):
    with open(path, 'rb') as f:
        return dict(zip('magic version w h seq slot nslot matrix full'.split(), struct.unpack('<9I', f.read(36))))


def summary(name, evs):
    st = [e for e in evs if e['ev'] == 'stats']
    print('  %s: %s' % (name, ' | '.join(json.dumps(e, separators=(',', ':')) for e in evs if e['ev'] != 'stats')))
    for e in st:
        print('  %s stats %s' % (name, json.dumps(e, separators=(',', ':'))))
    return st[-1] if st else {}


def main():
    camdec, work, main_file = sys.argv[1:4]
    second = sys.argv[4] if len(sys.argv) > 4 else None
    extra = sys.argv[5:]
    os.makedirs(work, exist_ok=True)
    data = open(main_file, 'rb').read()

    # 1. steady stream: ready (size + SPS fps), stats, eof, exit 0, MGVF header
    rc, evs, out = run(camdec, work, 'steady', data)
    last = summary('steady', evs)
    check(rc == 0, 'steady: exit 0 on stdin EOF')
    check(evs and evs[0]['ev'] == 'ready' and evs[0]['w'] == 1920 and evs[0]['h'] == 720 and evs[0]['fps'] == 30.0,
          'steady: first line ready 1920x720 fps 30')
    check(evs and evs[-1] == {'ev': 'eof'}, 'steady: last line eof')
    check(len([e for e in evs if e['ev'] == 'stats']) >= 2, 'steady: stats every 2 s')
    check(not [e for e in evs if e['ev'] == 'error'], 'steady: no error')
    h = head(out)
    check(h['magic'] == 0x4656474d and h['w'] == 1920 and h['h'] == 720 and h['nslot'] == 3, 'steady: MGVF 1920x720, 3 slots')
    check(h['matrix'] == 1 and h['full'] == 0, 'steady: MGVF BT.709 limited')
    check(h['seq'] >= last.get('shown', 0) > 100, 'steady: MGVF seq %d >= shown %d' % (h['seq'], last.get('shown', 0)))
    check(last.get('dropped', 99) <= 2, 'steady: no catch-up drops (dropped %s)' % last.get('dropped'))

    # 2. jitter 0..25 ms and a 500 ms stall at frame 60: the burst is caught up
    rc, evs, out = run(camdec, work, 'jitter', data, ['--jitter', '25', '--stall', '60:500', '--seed', '3'])
    last = summary('jitter', evs)
    check(rc == 0 and evs[-1] == {'ev': 'eof'}, 'jitter: exit 0, eof')
    check(last.get('dropped', 0) >= 5, 'jitter: the stall burst (15 frames at once) is cut down to the queue limit (dropped %s)'
          % last.get('dropped'))
    check(last.get('queue', 99) <= 4, 'jitter: queue <= 4')

    # 3. a decode error: error event, then the next IDR restarts (ready again)
    rc, evs, out = run(camdec, work, 'error', data, env={'CAMDEC_FAKE_FAIL': '40'})
    summary('error', evs)
    kinds = [e['ev'] for e in evs]
    check(rc == 0, 'error: exit 0')
    check(kinds.count('error') == 1 and kinds.count('ready') == 2 and kinds.index('error') < len(kinds) - 1 - kinds[::-1].index('ready'),
          'error: one error, then ready again at the next IDR')

    # 4. a new SPS mid-stream (another size and rate): reset, ready with the new numbers, MGVF re-created
    if second:
        rc, evs, out = run(camdec, work, 'newsps', data[:len(data) // 2] + open(second, 'rb').read())
        summary('newsps', evs)
        rd = [e for e in evs if e['ev'] == 'ready']
        h = head(out)
        check(rc == 0 and len(rd) == 2, 'newsps: two ready events')
        if len(rd) == 2:
            check((rd[1]['w'], rd[1]['h']) == (h['w'], h['h']) and (rd[1]['w'], rd[1]['h']) != (1920, 720),
                  'newsps: MGVF re-created at %dx%d fps %s' % (h['w'], h['h'], rd[1]['fps']))

    # 5. exit codes: bad arguments, MGVF that cannot be created
    p = subprocess.run([camdec, '--bogus'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
    check(p.returncode == 2 and b'"ev":"error"' in p.stdout, 'args: exit 2 with an error line')
    rc, evs, out = run(camdec, work, 'badout', data[:300000], args=['--out', os.path.join(work, 'no/such/dir/x')])
    summary('badout', evs)
    check(rc == 2 and evs and evs[-1]['ev'] == 'error', 'MGVF: exit 2 with an error line')

    # 6. extra real files (the live server's captures): ready + eof, exit 0
    for f in extra:
        n = os.path.basename(f).split('.')[0]
        rc, evs, out = run(camdec, work, n, open(f, 'rb').read(), ['--jitter', '10'])
        last = summary(n, evs)
        h = head(out)
        check(rc == 0 and evs[0]['ev'] == 'ready' and evs[-1] == {'ev': 'eof'} and h['seq'] > 0,
              '%s: ready %sx%s fps %s, eof, MGVF seq %d, dropped %s, held %s' % (
                  n, evs[0].get('w'), evs[0].get('h'), evs[0].get('fps'), h['seq'], last.get('dropped'),
                  last.get('held')))
        os.unlink(out)

    print('smoke: %d failed' % fails)
    sys.exit(1 if fails else 0)


if __name__ == '__main__':
    main()
