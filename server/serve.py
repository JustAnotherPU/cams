#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""RideWatch server: one H.264 stream of the UniFi Protect cameras, encoded at exactly the car's rect.

Runs per connection under systemd socket activation (jap-ridewatch.socket, Accept=yes): stdin/stdout = the TCP socket.
Request, one line:  <token> mosaic2 <W>x<H>            -> one JSON line {"ev":"layout",...,"tiles":[{i,name,x,y,w,h}]}, then as mosaic
                    <token> list                      -> JSON [{"i":0,"name":"Garage","shape","w","h","roles"}, ...] and close
                    <token> spot <hero> [o=<i,i,..>] <W>x<H>  -> layout line, then the hero big + the others in the pane
                                                      (o=: the user's order, spot_layout())
                    <token> mosaic <W>x<H>             -> raw Annex-B H.264, every camera in a grid, W x H
                    <token> cam <i> <W>x<H>            -> raw Annex-B H.264, camera i alone, fitted into W x H
                    <token> events                    -> the timeline (events_feed())
                    <token> thumb <id>                -> an event's JPEG, or nothing
                    <token> clip <id> <W>x<H>          -> one JSON line {"ev":"clip",...} (or {"ev":"clip","error":..}),
                                                      then the event's recording from Protect at real time, then close
<token>: a car's code (cams.json "cars", added with configure.py --add-car). A wrong one: closed without a word.
The stream runs until the client closes (a clip: until it ends). No B-frames, SPS/PPS before every IDR, 1 s GOP: a decoder
joining or recovering waits at most 1 s.
Config /opt/jap-ridewatch/cams.json (0600, written by configure.py):
  {"cars": ["<code>", ...], "protect": {"host", "username", "password"},
   "cams": [{"name", "label", "protectId", "roles": ["door"|"garage"|"day"|"night"],
             "channels": [{"id", "w", "h", "fps", "alias", "url"?}]}]}
  (a channel's "url", by hand: another RTSP source for that camera, used instead of Protect's RTSPS)
"""
import json, math, os, re, secrets, signal, subprocess, sys, tempfile

CONF = os.environ.get('JAP_RIDEWATCH_CONF', '/opt/jap-ridewatch/cams.json')
URL = 'rtsps://{}:7441/{}'  # Protect's RTSPS, on the Protect host (use())
HOST = ['']
ROLES = ('door', 'garage', 'day', 'night')
MOSAIC_FPS = 30           # most Protect channels are 30 fps (some 24 or 20)
FILL_MAX_CROP = 0.15
BT709 = 'flags=lanczos:out_color_matrix=bt709:out_range=tv'   # MGVF header on the car: BT.709 limited     # same rule as ytdec: crop to fill when it cuts at most 15 %, else fit (black bars)


def even(v):
    return max(2, int(v) // 2 * 2)


def grid(n, W, H, ar=16 / 9):
    """cols, rows for n tiles in W x H, maximising the area a 16:9 picture covers in a tile."""
    def area(c):
        r = math.ceil(n / c); tw, th = W / c, H / r
        return min(tw, th * ar) * min(th, tw / ar)
    c = max(range(1, n + 1), key=area)
    return c, math.ceil(n / c)


def fit(sw, sh, tw, th):
    """ffmpeg filter scaling sw x sh into tw x th: fill (crop) when it cuts <= 15 %, else fit + pad."""
    cover = max(tw / sw, th / sh)
    crop = 1 - (tw * th) / (sw * cover * sh * cover)
    if crop <= FILL_MAX_CROP:
        return 'scale=%d:%d:force_original_aspect_ratio=increase:%s,crop=%d:%d' % (tw, th, BT709, tw, th)
    return 'scale=%d:%d:force_original_aspect_ratio=decrease:%s,pad=%d:%d:(ow-iw)/2:(oh-ih)/2' % (tw, th, BT709, tw, th)


def channel(cam, tw, th, mosaic):
    """the smallest channel at least as big as its fitted size; never the 4K main one unless nothing else."""
    chans = sorted(cam['channels'], key=lambda c: c['w'] * c['h'])
    chans = [c for c in chans if c.get('fps', 30) >= 10] or chans    # a doorbell's 3 fps package channel: never
    if len(chans) > 1:
        chans = [c for c in chans if c['id'] != 0]
    for c in chans:
        s = min(tw / c['w'], th / c['h'])
        if s <= 1:
            return c
    return chans[-1]


# drop what the decoder conceals before the camera's first keyframe (Protect starts mid-GOP: ~1-4 s of gray smear)
KEYGATE = "select='if(key,st(0,1),0)+ld(0)',"
PROBE = ['-probesize', '256k', '-analyzeduration', '300000']


def inputs(cams, fifos=None, tile=None):
    """ffmpeg opens its inputs one by one, probing each (0.55-4 s per camera over RTSPS: 6 s for 11). For the mosaic
    each camera is opened, decoded and scaled to its tile by its own ffmpeg, all at once, which writes raw I420
    frames into a FIFO: here those open with nothing to probe (known size), and are stamped with the wall clock,
    so every tile is aligned on arrival time."""
    a = []
    for k, c in enumerate(cams):
        if fifos:
            a += ['-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', '%dx%d' % tile, '-framerate', str(MOSAIC_FPS),
                  '-thread_queue_size', '8', '-i', fifos[k]]
        else:
            a += ['-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay'] + PROBE + ['-i', src_url(c)]
    return a


def src_url(ch):
    """a channel's own url (by hand in cams.json, e.g. a prebuffered rebroadcast: starts at once) or Protect's RTSPS"""
    return ch.get('url') or URL.format(HOST[0], ch['alias'])


def use(conf):
    """the Protect host of cams.json for the RTSPS urls"""
    HOST[0] = str((conf.get('protect') or {}).get('host', ''))


def tokens(conf):
    """the cars' codes (and an older cams.json's single "token")"""
    return [t.encode() for t in [conf.get('token')] + list(conf.get('cars') or []) if isinstance(t, str) and t]


def puller(ch, fifo, tw, th):
    """one camera -> its tile, raw I420 at MOSAIC_FPS, into a FIFO (blocks until the compositor opens it)"""
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-rtsp_transport', 'tcp',
             '-fflags', 'nobuffer', '-flags', 'low_delay'] + PROBE + ['-i', src_url(ch), '-map', '0:v:0', '-an',
            '-vf', KEYGATE + 'fps=%d,%s,setsar=1,format=yuv420p' % (MOSAIC_FPS, fit(ch['w'], ch['h'], tw, th)),
            '-f', 'rawvideo', fifo])


def command(cams, view, W, H, fifos=None):
    if view == 'mosaic':
        fps = MOSAIC_FPS
        cols, rows = grid(len(cams), W, H)
        tw, th = even(W / cols), even(H / rows)
        chans = [channel(c, tw, th, True) for c in cams]
        parts, labels, layout = [], [], []
        for k, ch in enumerate(chans):
            if fifos:                            # already scaled by its puller
                parts.append('[%d:v]setsar=1[t%d]' % (k, k))
            else:
                parts.append('[%d:v]fps=%d,%s,setsar=1[t%d]' % (k, fps, fit(ch['w'], ch['h'], tw, th), k))
            labels.append('[t%d]' % k)
        n = len(chans)
        for k in range(n, cols * rows):          # empty slots: black
            parts.append('color=black:s=%dx%d:r=%d[t%d]' % (tw, th, fps, k)); labels.append('[t%d]' % k)
        for k in range(cols * rows):
            layout.append('%d_%d' % (k % cols * tw, k // cols * th))
        # xstack emits on every input's frame (11 x 30/s): fps= keeps the newest of each at a steady 30
        parts.append('%sxstack=inputs=%d:layout=%s:shortest=0,fps=%d,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=yuv420p[v]'
                     % (''.join(labels), cols * rows, '|'.join(layout), fps, W, H))
        src = chans
    else:
        cam = cams[view]
        ch = channel(cam, W, H, False)
        fps = ch.get('fps', 30)                  # the camera's own rate: no duplicated or dropped frames, no judder
        if fifos:                                # puller already fitted it to W x H at fps
            return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'yuv420p',
                     '-s', '%dx%d' % (W, H), '-framerate', str(fps),
                     '-thread_queue_size', '8', '-i', fifos[0], '-filter_complex', '[0:v]fps=%d,setsar=1[v]' % fps] + encode(fps))
        parts = ['[0:v]' + KEYGATE + 'setpts=PTS-STARTPTS,fps=%d,%s,setsar=1,format=yuv420p[v]' % (fps, fit(ch['w'], ch['h'], W, H))]
        src = [ch]
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin'] + inputs(src, fifos if view == 'mosaic' else None, (tw, th) if fifos else None) +
            ['-filter_complex', ';'.join(parts)] + encode(fps))


RATE = [8000, 8000]                                 # kbit/s cap and VBV size; cams.json maxrate_k / bufsize_k override


def encode(fps):
    return ['-map', '[v]', '-an',
            '-c:v', 'libx264', '-preset', 'faster', '-tune', 'zerolatency', '-profile:v', 'high',
            '-bf', '0', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
            '-g', str(fps), '-keyint_min', str(fps), '-x264-params', 'repeat-headers=1',
            # quality-capped VBR: CRF 20, never above 8 Mbit/s (cams.json maxrate_k), 1 s VBV
            '-crf', '20', '-maxrate', '%dk' % RATE[0], '-bufsize', '%dk' % RATE[1], '-r', str(fps), '-f', 'h264', 'pipe:1']


def main():
    signal.alarm(10)                                  # a silent peer must not hold one of the socket's connections
    conf = json.load(open(CONF))
    line = sys.stdin.buffer.readline(256).decode('ascii', 'replace').split()
    if len(line) < 2 or not any(secrets.compare_digest(line[0].encode(), t) for t in tokens(conf)):
        sys.exit(1)                                   # an unknown car: close, say nothing
    signal.alarm(0)
    use(conf)
    cams = conf['cams']
    RATE[:] = [int(conf.get('maxrate_k', RATE[0])), int(conf.get('bufsize_k', RATE[1]))]
    if line[1] == 'list':
        sys.stdout.write(json.dumps([dict({'i': i, 'name': c['name'], 'label': c.get('label', c['name']), 'shape': shape(c),
                                           'roles': [r for r in c.get('roles', []) if r in ROLES]}, **size(c))
                                     for i, c in enumerate(cams)]) + '\n'); return
    if line[1] == 'events' and len(line) == 2:
        events_feed(); return
    if line[1] == 'thumb' and len(line) == 3 and re.fullmatch(r'[0-9a-f]{12}', line[2]):
        try:
            sys.stdout.buffer.write(open(os.path.join(STATE, 'thumbs', line[2] + '.jpg'), 'rb').read())
        except OSError:
            pass
        return
    m = re.fullmatch(r'(\d{2,4})x(\d{2,4})', line[-1])
    if not m:
        sys.exit(2)
    W, H = even(min(int(m.group(1)), 2048)), even(min(int(m.group(2)), 2048))
    if line[1] == 'clip' and len(line) == 4 and re.fullmatch(r'[0-9a-f]{12}', line[2]):
        sys.exit(clip(conf, line[2], W, H))
    order = line[3][2:] if len(line) == 5 and line[3].startswith('o=') else None
    if line[1] == 'spot' and len(line) == (4 if order is None else 5) and line[2].isdigit() and int(line[2]) < len(cams):
        lo = spot_layout(cams, int(line[2]), W, H, parse_order(order, len(cams)) if order is not None else None)
        srcs = spot_pullers(cams, lo, 0)
        fps = srcs[0][0].get('fps', 30)                # the hero's own rate: it is the picture that is watched
        sys.stdout.write(json.dumps(lo) + '\n'); sys.stdout.flush()
        d = tempfile.mkdtemp(prefix='jap-ridewatch-')
        fifos = []
        jobs = []
        rects = [lo['heroRect']] + lo['tiles']
        for k, (ch, vf, pix) in enumerate(srcs):
            f = os.path.join(d, '%d.yuv' % k); os.mkfifo(f, 0o600); fifos.append(f)
            jobs.append((raw_puller(ch, 'pipe:1', vf, pix, fps), f,
                         placeholder(rects[k]['w'], rects[k]['h'], pix, 16 if k == 0 else 28)))
        run_tiles(jobs, fps, spot_command(cams, lo, fifos, fps))
    if line[1] in ('mosaic', 'mosaic2') and len(line) == 3:
        view = 'mosaic'
        if line[1] == 'mosaic2':                      # one JSON line first, then the H.264 bytes
            sys.stdout.write(json.dumps(layout(cams, W, H)) + '\n'); sys.stdout.flush()
    elif line[1] == 'cam' and len(line) == 4 and line[2].isdigit() and int(line[2]) < len(cams):
        view = int(line[2])
    else:
        sys.exit(2)
    fifos = None
    if view == 'mosaic':
        tw, th, srcs = mosaic_sources(cams, W, H)
        d = tempfile.mkdtemp(prefix='jap-ridewatch-')      # PrivateTmp=yes in the unit: gone when the stream stops
        fifos, jobs, still = [], [], placeholder(tw, th, 'yuv420p', 28)
        for k, ch in enumerate(srcs):
            f = os.path.join(d, '%d.yuv' % k); os.mkfifo(f, 0o600); fifos.append(f)
            jobs.append((puller(ch, 'pipe:1', tw, th), f, still))
        run_tiles(jobs, MOSAIC_FPS, command(cams, view, W, H, fifos), hold=False)   # (no main picture)
    ch = channel(cams[view], W, H, False)             # one camera: same relay, black until its keyframe
    fps = ch.get('fps', 30)
    d = tempfile.mkdtemp(prefix='jap-ridewatch-'); f = os.path.join(d, '0.yuv'); os.mkfifo(f, 0o600)
    run_tiles([(raw_puller(ch, 'pipe:1', fit(ch['w'], ch['h'], W, H), 'yuv420p', fps), f, placeholder(W, H, 'yuv420p', 16))],
              fps, command(cams, view, W, H, [f]))


STATE = os.environ.get('JAP_RIDEWATCH_STATE', '/var/lib/jap-ridewatch')


def event_rows(path):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return []


def events_feed(out=None, polls=None, sleep=None):
    """the timeline: the last 50 rows, then every new or changed row (events.py rewrites the file atomically), and a
    ping every 15 s so a dead link shows. Ends when the client goes (a write fails)."""
    import time
    out = out or sys.stdout; sleep = sleep or time.sleep
    path = os.path.join(STATE, 'events.json')
    rows = event_rows(path)
    sent = {e['id']: (e['ts'], e['count'], e['thumb']) for e in rows}
    out.write(json.dumps({'ev': 'events', 'list': rows[-50:]}) + '\n'); out.flush()
    mtime, idle, n = None, 0.0, 0
    while polls is None or n < polls:
        n += 1
        sleep(0.5); idle += 0.5
        try:
            st = os.stat(path); m = (st.st_ino, st.st_mtime_ns, st.st_size)   # Linux mtime is coarse (~4 ms): events.py's os.replace gives a new inode
        except OSError:
            m = None
        if m != mtime:
            mtime = m
            for e in event_rows(path):
                k = (e['ts'], e['count'], e['thumb'])
                if sent.get(e['id']) != k:
                    sent[e['id']] = k
                    out.write(json.dumps(dict(e, ev='event')) + '\n'); idle = 0
        if idle >= 15:
            out.write('{"ev":"ping"}\n'); idle = 0
        out.flush()


# an event's recording: UniFi Protect's private API on the Protect console (verified with a View Only local user:
# login, cameras, video/export -> MP4, HEVC + AAC, starting at the keyframe before `start`)
# Protect's own channel index for an export: 0 = the main recording, the HD one (channel=1 gave a 640x360 picture,
# not the 1280x720 channel 1 of the live view, so cams.json ids do not map here); the server scales it to the car's rect
EXPORT_CHANNEL = 0
CLIP_PRE, CLIP_POST, CLIP_MAX = 5000, 15000, 90000  # ms before the first hit, after the last, at most in all


class ProtectError(Exception):
    """args: (code, detail): the code goes to the car (ridewatchd words it), the detail to the journal; neither holds secrets"""


def http(method, url, headers, body=None, timeout=10, out=None):
    """(status, headers, body) with a timeout on every socket operation; out: a 200's body is copied into that file"""
    import shutil, ssl, urllib.error, urllib.request
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    ctx = ssl._create_unverified_context() if url.startswith('https:') else None   # the console's self-signed cert: LAN only
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
            if out is None:
                return r.status, r.headers, r.read(1 << 22)
            shutil.copyfileobj(r, out, 1 << 20)
            return r.status, r.headers, b''
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read(2000)
    except (OSError, ValueError) as e:                 # refused, timeout, DNS, TLS
        raise ProtectError('unreachable', '%s %s: %s' % (method, url.split('?')[0], e))


def base(conf):
    """Protect's address: https://<protect.host> (JAP_RIDEWATCH_PROTECT_URL overrides it, for the selftests)"""
    if os.environ.get('JAP_RIDEWATCH_PROTECT_URL'):
        return os.environ['JAP_RIDEWATCH_PROTECT_URL']
    h = (conf.get('protect') or {}).get('host')
    if not h or not re.fullmatch(r'[A-Za-z0-9.:\[\]-]+', str(h)):
        raise ProtectError('config', 'cams.json has no valid "protect": {"host"}')
    return 'https://' + h


def session_path():
    return os.path.join(STATE, 'protect-session.json')


def login(conf):
    p = conf.get('protect') or {}
    if not p.get('username') or not p.get('password'):
        raise ProtectError('config', 'cams.json has no "protect": {"username", "password"}')
    st, h, b = http('POST', base(conf) + '/api/auth/login', {'Content-Type': 'application/json'},
                    json.dumps({'username': p['username'], 'password': p['password'], 'rememberMe': False}).encode())
    tok = re.search(r'\bTOKEN=([^;,\s]+)', ', '.join(h.get_all('Set-Cookie') or []))
    if st != 200 or not tok:
        raise ProtectError('login', 'login: HTTP %d%s' % (st, '' if tok else ', no TOKEN cookie'))
    s = {'cookie': 'TOKEN=' + tok.group(1), 'csrf': h.get('X-CSRF-Token', '')}
    session_save(s)
    return s


def session_save(s):
    tmp = session_path() + '.tmp'
    with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
        json.dump(s, f)
    os.replace(tmp, session_path())


def protect_get(conf, path, out=None, timeout=10):
    """GET with the cached session; on 401/403 one new login and one retry (the console rate-limits logins)"""
    try:
        s = json.load(open(session_path()))
    except (OSError, ValueError):
        s = None
    fresh = False
    while True:
        if s is None:
            s, fresh = login(conf), True
        if out is not None:
            out.seek(0); out.truncate()
        st, h, b = http('GET', base(conf) + path, {'Cookie': s['cookie'], 'X-CSRF-Token': s['csrf']}, None, timeout, out)
        if st in (401, 403) and not fresh:
            s = None; continue
        if h.get('X-Updated-CSRF-Token'):
            s['csrf'] = h['X-Updated-CSRF-Token']; session_save(s)
        if st != 200:
            raise ProtectError('cameras' if out is None else 'export', '%s: HTTP %d %r' % (path.split('?')[0], st, b[:200]))
        return b


def probe(f):
    """(w, h, fps, ms) of an MP4's first video stream"""
    try:
        r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                            'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', f], capture_output=True, timeout=15)
        j = json.loads(r.stdout or b'{}')
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        raise ProtectError('export', 'ffprobe: %s' % e)
    v = (j.get('streams') or [{}])[0]
    n, _, d = v.get('avg_frame_rate', '30/1').partition('/')
    fps = round(float(n) / float(d)) if d and float(d) else 30
    return v.get('width'), v.get('height'), max(1, min(60, fps or 30)), int(float(j.get('format', {}).get('duration', 0)) * 1000)


def clip_command(f, W, H, sw, sh, fps):
    """the recording at real time, fitted like a `cam` view, with the live views' encoder"""
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-i', f, '-filter_complex',
             '[0:v]fps=%d,%s,setsar=1,format=yuv420p[v]' % (fps, fit(sw, sh, W, H))] + encode(fps))


def clip(conf, eid, W, H, out=None, now=None):
    """`clip <id> WxH`: the event's row, its camera's Protect id, the export (first - 5 s .. last + 15 s, <= 90 s) into
    a temp file, one JSON line, then the clip as H.264 at real time. A failure: an error line, then close."""
    import shutil, time, urllib.parse
    out = out or sys.stdout.buffer
    now = now or int(time.time() * 1000)

    def say(o):
        out.write((json.dumps(o) + '\n').encode()); out.flush()
    d = tempfile.mkdtemp(prefix='jap-ridewatch-')
    try:
        row = next((e for e in event_rows(os.path.join(STATE, 'events.json')) if e.get('id') == eid), None)
        if row is None or not isinstance(row.get('cam'), int) or not 0 <= row['cam'] < len(conf['cams']):
            raise ProtectError('event', 'no such event')
        name = conf['cams'][row['cam']]['name']
        ids = [conf['cams'][row['cam']].get('protectId')]
        if not ids[0]:                                 # a cams.json written by hand: by name
            try:
                ids = [c.get('id') for c in json.loads(protect_get(conf, '/proxy/protect/api/cameras')) if isinstance(c, dict) and c.get('name') == name]
            except (ValueError, AttributeError, TypeError):
                raise ProtectError('cameras', 'cameras: not a JSON list')
        if not ids or not ids[0]:
            raise ProtectError('camera', 'no Protect camera named %r' % name)
        first = row.get('first', row['ts'])
        start = first - CLIP_PRE
        end = min(max(row['ts'], first) + CLIP_POST, start + CLIP_MAX, now)
        f = os.path.join(d, 'clip.mp4')
        q = {'camera': ids[0], 'start': start, 'end': end, 'channel': EXPORT_CHANNEL}
        with open(f, 'w+b') as fo:
            protect_get(conf, '/proxy/protect/api/video/export?' + urllib.parse.urlencode(q), fo, 30)
            fo.seek(4); magic = fo.read(4)
        if magic != b'ftyp':
            raise ProtectError('export', 'export: not an MP4 (%r)' % magic)
        sw, sh, fps, dur = probe(f)
        if not sw or not sh:
            raise ProtectError('export', 'export: no video stream')
    except ProtectError as e:
        sys.stderr.write('clip %s: %s\n' % (eid, e.args[1]))
        say({'ev': 'clip', 'error': e.args[0]})
        shutil.rmtree(d, ignore_errors=True)
        return 1
    say({'ev': 'clip', 'id': eid, 'cam': row['cam'], 'label': row.get('label', name), 'type': row.get('type'),
         'start': start, 'dur': dur or end - start})
    try:
        return subprocess.call(clip_command(f, W, H, sw, sh, fps), stdin=subprocess.DEVNULL, stdout=out)
    finally:
        shutil.rmtree(d, ignore_errors=True)


ALIAS = re.compile(r'[A-Za-z0-9_-]{1,64}')


def discover(conf):
    """cams.json's cameras from Protect's camera list: ([{name, label, protectId, doorbell, channels: [{id, w, h, fps,
    alias}]}], [the channels with RTSP off, "camera: channel"]). A channel needs RTSP turned on in Protect (a View Only
    user cannot do it); a camera with none is left out."""
    try:
        raw = json.loads(protect_get(conf, '/proxy/protect/api/cameras'))
        if not isinstance(raw, list):
            raise ValueError
    except ValueError:
        raise ProtectError('cameras', 'cameras: not a JSON list')
    num = lambda v: isinstance(v, int) and not isinstance(v, bool) and 0 < v <= 16384
    cams, off = [], []
    for c in raw:
        if not isinstance(c, dict) or not isinstance(c.get('id'), str) or not isinstance(c.get('name'), str):
            continue
        chans = []
        for ch in c.get('channels') or []:
            if not isinstance(ch, dict) or ch.get('enabled') is False or not isinstance(ch.get('id'), int):
                continue
            if ch.get('isRtspEnabled') and isinstance(ch.get('rtspAlias'), str) and ALIAS.fullmatch(ch['rtspAlias']) \
                    and num(ch.get('width')) and num(ch.get('height')):
                fps = ch.get('fps') if num(ch.get('fps')) and ch['fps'] <= 120 else 30
                chans.append({'id': ch['id'], 'w': ch['width'], 'h': ch['height'], 'fps': fps, 'alias': ch['rtspAlias']})
            else:
                off.append('%s: %s' % (c['name'], ch.get('name') or ch['id']))
        if chans:
            cams.append({'name': c['name'], 'label': c['name'], 'protectId': c['id'],
                         'doorbell': bool((c.get('featureFlags') or {}).get('isDoorbell')), 'channels': chans})
    return cams, off


def layout(cams, W, H):
    """where each camera sits in the mosaic, in stream pixels: the app hit-tests and labels from this"""
    cols, rows = grid(len(cams), W, H)
    tw, th = even(W / cols), even(H / rows)
    ox, oy = (W - cols * tw) // 2, (H - rows * th) // 2          # the pad= centring in command()
    return {'ev': 'layout', 'w': W, 'h': H, 'hero': None,
            'tiles': [{'i': k, 'name': c['name'], 'x': ox + k % cols * tw, 'y': oy + k // cols * th, 'w': tw, 'h': th}
                      for k, c in enumerate(cams)]}


def shape(cam):
    ch = max(cam['channels'], key=lambda c: c['w'] * c['h'])
    r = ch['w'] / ch['h']
    return 'wide' if r > 1.2 else 'round' if r > 0.9 else 'tall'


def size(cam):
    """the camera's picture size (its largest channel): the car frames `cam` views from its aspect"""
    ch = max(cam['channels'], key=lambda c: c['w'] * c['h'])
    return {'w': ch['w'], 'h': ch['h']}


def parse_order(s, n):
    """o=3,1,0,..: the user's arrangement, first the camera at home in the hero's place (unknown or repeated ids
    dropped, missing ones appended): the request line is untrusted"""
    out = []
    for v in s.split(',')[:64]:
        if v.isdigit() and int(v) < n and int(v) not in out:
            out.append(int(v))
    return out + [i for i in range(n) if i not in out]


def arrange(order, hero):
    """the pane's cameras in the user's order: the hero leaves its place to the order's first camera, so nothing
    else moves when an event changes the hero"""
    p = list(order)
    if p[0] != hero:
        p[p.index(hero)] = p[0]
    return p[1:]


def spot_layout(cams, hero, W, H, order=None):
    """Concept A "Projecteur": the hero at its native 16:9 size on the left (1280x720 on a 720-high screen), a
    frosted pane on the right: six 16:9 thumbs in 2 x 3, then a band with one tall (3:4) slot and three round ones.
    A camera whose shape has no free slot of its own takes any free slot, centre-cropped. The cameras take the
    slots in camera order, or in the user's (order: parse_order()), each shape's slots in reading order."""
    hw = min(even(H * 16 / 9), even(W * 2 / 3)); pw = W - hw
    tw = even(pw / 2); th = even(tw * 9 / 16); by = 3 * th; bh = H - by
    tall_w = even(bh * 3 / 4); cell = (pw - tall_w) // 3; rd = even(min(bh - 20, cell - 8))
    slots = [('wide', hw + c * tw, r * th, tw, th) for r in range(3) for c in range(2)]
    slots += [('tall', hw, by, tall_w, bh)]
    slots += [('round', hw + tall_w + k * cell + (cell - rd) // 2, by + (bh - rd) // 2, rd, rd) for k in range(3)]
    others = arrange(order, hero) if order else [i for i in range(len(cams)) if i != hero]
    free, tiles = list(slots), []
    for pass_ in (0, 1):                          # own shape first, then whatever is left
        for i in [i for i in others if i not in {t['i'] for t in tiles}]:
            s = next((s for s in free if pass_ or s[0] == shape(cams[i])), None)
            if s:
                free.remove(s)
                c = cams[i]
                tiles.append({'i': i, 'name': c['name'], 'label': c.get('label', c['name']), 'shape': s[0],
                              'x': s[1], 'y': s[2], 'w': s[3], 'h': s[4]})
    hc = channel(cams[hero], hw, H, False)
    s = min(hw / hc['w'], H / hc['h'])
    rw, rh = even(hc['w'] * s), even(hc['h'] * s)
    return {'ev': 'layout', 'w': W, 'h': H, 'hero': hero, 'pane': {'x': hw, 'y': 0, 'w': pw, 'h': H},
            'heroRect': {'x': (hw - rw) // 2, 'y': (H - rh) // 2, 'w': rw, 'h': rh},
            'heroName': cams[hero]['name'], 'heroLabel': cams[hero].get('label', cams[hero]['name']),
            'tiles': sorted(tiles, key=lambda t: (t['y'], t['x']))}


def cover(w, h):
    return 'scale=%d:%d:force_original_aspect_ratio=increase:%s,crop=%d:%d' % (w, h, BT709, w, h)


def frosted(w, h, dark):
    """a blurred, darkened copy filling w x h: blur at 1/8 size (cheap), scaled back up: the frosted glass"""
    sw, sh = even(w / 8), even(h / 8)
    return 'scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,boxblur=6:2,scale=%d:%d:flags=bicubic,eq=brightness=%.2f:saturation=0.75' % (sw, sh, sw, sh, w, h, dark)


def spot_command(cams, lo, fifos, fps):
    """compositor for spot: input 0 = the hero at heroRect size, 1.. = the tiles at their size (rounds with alpha)"""
    W, H, hr, pane = lo['w'], lo['h'], lo['heroRect'], lo['pane']
    hw = pane['x']
    a = []
    for k, f in enumerate(fifos):
        if k == 0:
            size, pix = (hr['w'], hr['h']), 'yuv420p'
        else:
            t = lo['tiles'][k - 1]; size, pix = (t['w'], t['h']), ('yuva420p' if t['shape'] == 'round' else 'yuv420p')
        a += ['-f', 'rawvideo', '-pix_fmt', pix, '-s', '%dx%d' % size, '-framerate', str(fps),
              '-thread_queue_size', '8', '-i', f]
    fitted = (hr['w'], hr['h']) != (hw, H)
    p = ['[0:v]split=%d[h0][hp]%s' % (3 if fitted else 2, '[hb]' if fitted else '')]
    if fitted:                                    # a 3:4 or square hero: on a blurred copy of itself
        p.append('[hb]%s[hbg]' % frosted(hw, H, -0.18))
        p.append('[hbg][h0]overlay=%d:%d,pad=%d:%d:0:0[b0]' % (hr['x'], hr['y'], W, H))
    else:
        p.append('[h0]pad=%d:%d:0:0[b0]' % (W, H))
    p.append('[hp]%s[pbg]' % frosted(pane['w'], H, -0.12))
    p.append('[b0][pbg]overlay=%d:0[b1]' % hw)
    last = 'b1'
    for k, t in enumerate(lo['tiles']):
        p.append('[%s][%d:v]overlay=%d:%d[b%d]' % (last, k + 1, t['x'], t['y'], k + 2)); last = 'b%d' % (k + 2)
    p.append('[%s]fps=%d,format=yuv420p[v]' % (last, fps))
    return ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin'] + a + ['-filter_complex', ';'.join(p)] + encode(fps)


def spot_pullers(cams, lo, fps):
    """(channel, filter, pix_fmt) for the hero then each tile: decoded and sized in their own process"""
    hr = lo['heroRect']
    hc = channel(cams[lo['hero']], hr['w'], hr['h'], False)
    out = [(hc, 'scale=%d:%d:%s' % (hr['w'], hr['h'], BT709), 'yuv420p')]
    for t in lo['tiles']:
        ch = channel(cams[t['i']], t['w'], t['h'], True)
        if t['shape'] == 'round':                 # square cameras: a circle, soft 1 px edge, the pane shows around it
            vf = cover(t['w'], t['h']) + ",format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='clip((W/2-hypot(X-W/2+0.5,Y-H/2+0.5))*255,0,255)'"
            out.append((ch, vf, 'yuva420p'))
        else:
            out.append((ch, cover(t['w'], t['h']), 'yuv420p'))
    return out


def raw_puller(ch, fifo, vf, pix, fps):
    return (['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-rtsp_transport', 'tcp',
             '-fflags', 'nobuffer', '-flags', 'low_delay'] + PROBE + ['-i', src_url(ch), '-map', '0:v:0', '-an',
            '-vf', KEYGATE + 'fps=%d,%s,setsar=1,format=%s' % (fps, vf, pix), '-f', 'rawvideo', fifo])


def placeholder(w, h, pix, y):
    """one raw frame shown until the camera's first keyframe: flat dark (y), transparent where there is alpha"""
    q = (w // 2) * (h // 2)
    return bytes([y]) * (w * h) + b'\x80' * (2 * q) + (b'\x00' * (w * h) if pix == 'yuva420p' else b'')


def relay(src, fifo, still, fps, real=None):
    """puller stdout -> compositor FIFO as a clock: exactly fps frames a second, each the newest whole frame from the
    puller (`still` until its camera's first keyframe, the last frame again if the camera is late, extra frames
    dropped). Every compositor input is then a steady stream counted in frames: nothing to wait for, no bursts.
    real (a threading.Event): set at the puller's first frame (its camera's keyframe is in)."""
    import threading, time
    fb, latest, done = len(still), [still], []

    def reader():
        buf = bytearray(fb); mv = memoryview(buf)
        while True:
            n = 0
            while n < fb:
                k = src.readinto(mv[n:])
                if not k:
                    done.append(1); return
                n += k
            latest[0] = bytes(buf)
            if real is not None:
                real.set()
    threading.Thread(target=reader, daemon=True).start()
    try:
        with open(fifo, 'wb', buffering=0) as out:
            import fcntl
            try:
                fcntl.fcntl(out.fileno(), 1031, 1 << 20)   # F_SETPIPE_SZ: a hero frame is 1.4 MB, the default pipe 64 KB
            except OSError:
                pass
            t = time.monotonic()
            while not done:
                out.write(latest[0])
                t += 1.0 / fps
                d = t - time.monotonic()
                if d > 0:
                    time.sleep(d)
                elif d < -1:                              # the compositor stalled a whole second: restart the clock
                    sys.stderr.write('relay %s: compositor %.1f s behind\n' % (os.path.basename(fifo), -d))
                    t = time.monotonic()
    except OSError:                                   # compositor gone: the unit ends with it
        pass


# The first IDR waits for the main picture's camera (job 0): the car keeps showing the view before until that IDR,
# so a switch goes from the old picture straight to the new one, never through the dark placeholder (Protect's first
# keyframe: 4.4 s measured). Past HOLD_S the view starts anyway (a dead camera: its placeholder); the car
# gives up on a view with no IDR after 10 s (ridewatchd FIRST_MS).
HOLD_S = 7


def run_tiles(jobs, fps, cmd, hold=True):
    """jobs = [(puller argv, fifo, still)]; runs the compositor on this process's stdout until it ends"""
    import threading
    real = threading.Event()
    for k, (argv, fifo, still) in enumerate(jobs):
        pr = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE)
        threading.Thread(target=relay, args=(pr.stdout, fifo, still, fps, real if k == 0 else None), daemon=True).start()
    if hold:
        real.wait(HOLD_S)
    sys.exit(subprocess.call(cmd, stdin=subprocess.DEVNULL))   # pullers share the unit's cgroup: stopped with it


def mosaic_sources(cams, W, H):
    cols, rows = grid(len(cams), W, H)
    tw, th = even(W / cols), even(H / rows)
    return tw, th, [channel(c, tw, th, True) for c in cams]


def selftest():
    assert grid(11, 1920, 720) == (4, 3), grid(11, 1920, 720)
    assert grid(11, 1836, 720) == (4, 3)
    assert grid(1, 1920, 720) == (1, 1)
    assert 'increase' in fit(640, 360, 480, 240)          # 16:9 into 2:1 crops 11 %: fill
    assert 'decrease' in fit(640, 640, 480, 240)          # square into 2:1: fit
    assert 'decrease' in fit(1280, 720, 1920, 720)        # full screen 16:9 into 8:3: fit, no upscale needed
    cam = {'name': 'x', 'channels': [{'id': 0, 'w': 3840, 'h': 2160, 'alias': 'a0'},
                                     {'id': 1, 'w': 1280, 'h': 720, 'alias': 'a1'},
                                     {'id': 2, 'w': 640, 'h': 360, 'alias': 'a2'}]}
    assert channel(cam, 480, 240, True)['id'] == 2
    assert channel(cam, 1920, 720, False)['id'] == 1      # 1280x720 fits 1920x720 at scale 1: native pixels
    door = {'name': 'd', 'channels': [{'id': 1, 'w': 1440, 'h': 1920, 'fps': 20, 'alias': 'b1'},
                                      {'id': 2, 'w': 480, 'h': 640, 'fps': 20, 'alias': 'b2'},
                                      {'id': 3, 'w': 1600, 'h': 1200, 'fps': 3, 'alias': 'b3'}]}
    assert channel(door, 1920, 720, False)['id'] == 1      # not the 3 fps package channel
    c1 = command([door], 0, 1920, 720); assert c1[c1.index('-r') + 1] == '20'
    cmd = command([cam] * 11, 'mosaic', 1920, 720)
    fc = cmd[cmd.index('-filter_complex') + 1]
    assert 'xstack=inputs=12' in fc and 'color=black:s=480x240' in fc
    assert cmd.count('-i') == 11 and 'repeat-headers=1' in cmd
    cmd = command([cam] * 11, 'mosaic', 1920, 720, ['/f%d' % k for k in range(11)])
    assert cmd.count('rawvideo') == 11 and '480x240' in cmd and 'scale=' not in cmd[cmd.index('-filter_complex') + 1]
    assert cmd.count('-framerate') == 11 and '/f10' in cmd and not any(a.startswith('rtsps') for a in cmd)
    pl = puller({'alias': 'a2', 'w': 640, 'h': 360}, '/f0', 480, 240)
    assert pl[-1] == '/f0' and 'rawvideo' in pl and 'crop=480:240' in pl[pl.index('-vf') + 1]
    assert src_url({'alias': 'a', 'url': 'rtsp://127.0.0.1:1/x'}) == 'rtsp://127.0.0.1:1/x' and src_url({'alias': 'a'}).endswith('/a')
    assert [c['id'] for c in mosaic_sources([cam] * 11, 1920, 720)[2]] == [2] * 11
    lo = layout([cam] * 11, 1836, 720)
    assert len(lo['tiles']) == 11 and lo['tiles'][0]['x'] == 2 and lo['tiles'][4] == {'i': 4, 'name': 'x', 'x': 2, 'y': 240, 'w': 458, 'h': 240}
    assert lo['tiles'][3]['x'] + lo['tiles'][3]['w'] <= 1836
    # spot (concept A) with the real camera set's shapes: 7 wide, 1 tall door, 3 round
    sq = {'name': 's', 'channels': [{'id': 1, 'w': 1280, 'h': 1280, 'fps': 24, 'alias': 's1'}, {'id': 2, 'w': 720, 'h': 720, 'fps': 24, 'alias': 's2'}]}
    real = [door] + [cam] * 7 + [sq] * 3
    assert [shape(c) for c in real] == ['tall'] + ['wide'] * 7 + ['round'] * 3
    lo = spot_layout(real, 1, 1920, 720)                    # a wide hero: native 1280x720, every slot by its own shape
    assert lo['heroRect'] == {'x': 0, 'y': 0, 'w': 1280, 'h': 720} and len(lo['tiles']) == 10
    assert [t['shape'] for t in lo['tiles'] if t['i'] == 0] == ['tall'] and sum(t['shape'] == 'round' for t in lo['tiles']) == 3
    assert all(t['x'] >= 1280 and t['x'] + t['w'] <= 1920 and t['y'] + t['h'] <= 720 for t in lo['tiles'])
    assert all(t['w'] % 2 == 0 and t['h'] % 2 == 0 for t in lo['tiles'])
    assert {(t['w'], t['h']) for t in lo['tiles'] if t['shape'] == 'wide'} == {(320, 180)}
    lo = spot_layout(real, 0, 1920, 720)                    # the doorbell hero: fitted 540x720, a wide cam takes its slot
    assert lo['heroRect'] == {'x': 370, 'y': 0, 'w': 540, 'h': 720} and len(lo['tiles']) == 10
    assert [t['shape'] for t in lo['tiles'] if t['i'] == 7] == ['tall']
    fps = 30; srcs = spot_pullers(real, lo, fps)
    cmd = spot_command(real, lo, ['/f%d' % k for k in range(11)], fps)
    fc = cmd[cmd.index('-filter_complex') + 1]
    assert cmd.count('-i') == 11 and cmd.count('yuva420p') == 3 and 'split=3' in fc and fc.count('overlay=') == 12
    assert "geq=" in srcs[-1][1] and srcs[0][1].startswith('scale=540:720')
    cmd = spot_command(real, spot_layout(real, 1, 1920, 720), ['/f%d' % k for k in range(11)], fps)
    assert 'split=2' in cmd[cmd.index('-filter_complex') + 1]
    # events feed: initial list, then only changed rows, pings when idle
    import io
    global STATE
    d = tempfile.mkdtemp(); STATE = d; p = os.path.join(d, 'events.json')
    json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Garage', 'type': 'person', 'ts': 1, 'count': 1, 'thumb': False}], open(p, 'w'))
    steps = iter([lambda: None,
                  lambda: (json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Garage', 'type': 'person', 'ts': 2, 'count': 2, 'thumb': True},
                                      {'id': 'b' * 12, 'cam': 0, 'label': 'Door', 'type': 'ring', 'ts': 3, 'count': 1, 'thumb': False}],
                                     open(p + '.tmp', 'w')), os.replace(p + '.tmp', p))]
                 + [lambda: None] * 40)
    buf = io.StringIO()
    events_feed(buf, polls=33, sleep=lambda s: next(steps)())
    lines = [json.loads(l) for l in buf.getvalue().splitlines()]
    assert lines[0]['ev'] == 'events' and len(lines[0]['list']) == 1
    assert [(l['ev'], l.get('id', '')[:1], l.get('count')) for l in lines[1:3]] == [('event', 'a', 2), ('event', 'b', 1)]
    assert {'ev': 'ping'} in lines[3:] and len(lines) == 4
    assert len(placeholder(320, 180, 'yuv420p', 28)) == 320 * 180 * 3 // 2
    a = placeholder(160, 160, 'yuva420p', 28); assert len(a) == 160 * 160 * 5 // 2 and a[-1] == 0 and a[0] == 28
    import threading, time as _t
    d2 = tempfile.mkdtemp(); ff = os.path.join(d2, 'f'); os.mkfifo(ff)
    r, w = os.pipe(); src = os.fdopen(r, 'rb')
    th = threading.Thread(target=relay, args=(src, ff, b'S' * 4, 50)); th.start()
    rd = os.open(ff, os.O_RDONLY); _t.sleep(0.15); os.write(w, b'REAL'); _t.sleep(0.1); os.close(w)
    got = b''
    while True:
        b = os.read(rd, 4096)
        if not b: break
        got += b
    th.join(); os.close(rd); import shutil; shutil.rmtree(d); shutil.rmtree(d2)
    assert got.startswith(b'SSSS') and b'REAL' in got and len(got) % 4 == 0, got
    # the hold: set by the first whole frame from the puller, not by the placeholder
    d3 = tempfile.mkdtemp(); f3 = os.path.join(d3, 'f'); os.mkfifo(f3)
    r, w = os.pipe(); ev = threading.Event()
    th = threading.Thread(target=relay, args=(os.fdopen(r, 'rb'), f3, b'S' * 4, 50, ev)); th.start()
    rd = os.open(f3, os.O_RDONLY); _t.sleep(0.1); assert not ev.is_set()
    os.write(w, b'RE'); _t.sleep(0.05); assert not ev.is_set(); os.write(w, b'AL'); assert ev.wait(1)
    os.close(w); th.join(); os.close(rd); shutil.rmtree(d3)
    # the user's order: the pane keeps it, the hero leaves its place to the order's first camera
    assert parse_order('3,x,1,3,99', 5) == [3, 1, 0, 2, 4] and parse_order('', 3) == [0, 1, 2]
    assert arrange([3, 1, 0, 2, 4], 3) == [1, 0, 2, 4] and arrange([3, 1, 0, 2, 4], 0) == [1, 3, 2, 4]
    wide = lambda lo: [t['i'] for t in sorted(lo['tiles'], key=lambda t: (t['y'], t['x'])) if t['shape'] == 'wide']
    assert wide(spot_layout(real, 1, 1920, 720)) == [2, 3, 4, 5, 6, 7]
    o = parse_order('1,7,6,5,4,3,2,0,10,9,8', 11)
    lo = spot_layout(real, 1, 1920, 720, o)
    assert wide(lo) == [7, 6, 5, 4, 3, 2] and [t['i'] for t in lo['tiles'] if t['shape'] == 'round'] == [10, 9, 8]
    assert wide(spot_layout(real, 6, 1920, 720, o)) == [7, 1, 5, 4, 3, 2]      # hero 6: 1 takes its place
    assert [t['shape'] for t in spot_layout(real, 0, 1920, 720, o)['tiles'] if t['i'] == 1] == ['tall']   # door hero: the 7th wide goes tall
    assert size(door) == {'w': 1440, 'h': 1920}
    assert tokens({'cars': ['AAAA-BBBB', 7, ''], 'token': 'old'}) == [b'old', b'AAAA-BBBB'] and tokens({}) == []
    use({'protect': {'host': '192.0.2.1'}}); assert src_url({'alias': 'abc'}) == 'rtsps://192.0.2.1:7441/abc'
    clip_selftest()
    print('selftest ok')


def clip_selftest():
    """`clip` against a fake Protect (http://127.0.0.1) and a 1 s MP4 from ffmpeg's testsrc (skipped without ffmpeg)"""
    import http.server, shutil, threading
    global STATE
    if not shutil.which('ffmpeg'):
        print('clip selftest skipped (no ffmpeg)'); return
    d = tempfile.mkdtemp(); STATE = d
    mp4 = os.path.join(d, 't.mp4')
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=1', '-c:v', 'libx264',
                    '-pix_fmt', 'yuv420p', mp4], check=True)
    P = {'logins': 0, 'token': 't1', 'asked': [], 'mp4': open(mp4, 'rb').read()}

    class Fake(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, st, body=b'', hdr=()):
            self.send_response(st)
            for k, v in hdr:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            b = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            P['logins'] += 1
            if self.path != '/api/auth/login' or b != {'username': 'u', 'password': 'p', 'rememberMe': False}:
                return self.reply(401)
            self.reply(200, b'{}', [('Set-Cookie', 'TOKEN=%s; path=/; samesite=strict; secure; httponly' % P['token']), ('X-CSRF-Token', 'c-' + P['token'])])

        def do_GET(self):
            if P.get('deny') or self.headers.get('Cookie') != 'TOKEN=' + P['token'] or self.headers.get('X-CSRF-Token') != 'c-' + P['token']:
                return self.reply(401)
            if self.path == '/proxy/protect/api/cameras':
                P['camlists'] = P.get('camlists', 0) + 1
                return self.reply(200, json.dumps(CAMERAS).encode())
            P['asked'].append(self.path)
            self.reply(200, P['mp4'])
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ['JAP_RIDEWATCH_PROTECT_URL'] = 'http://127.0.0.1:%d' % srv.server_address[1]
    now = 1762300000000
    json.dump([{'id': 'a' * 12, 'cam': 1, 'label': 'Garage', 'type': 'person', 'ts': now - 60000, 'first': now - 70000, 'count': 2, 'thumb': True},
               {'id': 'b' * 12, 'cam': 2, 'label': 'Attic', 'type': 'animal', 'ts': now - 5000, 'first': now - 5000, 'count': 1, 'thumb': False}],
              open(os.path.join(d, 'events.json'), 'w'))
    conf = {'cams': [{'name': 'Door'}, {'name': 'Garage'}, {'name': 'Attic'}], 'protect': {'host': '192.0.2.1', 'username': 'u', 'password': 'p'}}

    def run(eid, c=conf):
        o = tempfile.TemporaryFile()
        rc = clip(c, eid, 640, 240, o, now)
        o.seek(0); b = o.read()
        k = b.index(b'\n')
        return rc, json.loads(b[:k]), b[k + 1:]
    rc, j, v = run('a' * 12)
    assert rc == 0 and j['ev'] == 'clip' and (j['id'], j['cam'], j['label'], j['type']) == ('a' * 12, 1, 'Garage', 'person'), j
    assert j['start'] == now - 75000 and 900 <= j['dur'] <= 1100, j
    assert P['asked'] == ['/proxy/protect/api/video/export?camera=c1&start=%d&end=%d&channel=0' % (now - 75000, now - 45000)], P['asked']
    assert all(b'\x00\x00\x01' + bytes([t]) in v for t in (0x67, 0x68, 0x65)), 'Annex-B with SPS, PPS, IDR'
    assert P['logins'] == 1 and os.stat(session_path()).st_mode & 0o777 == 0o600
    run('a' * 12)
    assert P['logins'] == 1, 'the cached session is reused'
    P['token'] = 't2'                                 # the session expired on the console: one new login, then the clip
    rc, j, _ = run('b' * 12)
    assert P['logins'] == 2 and j.get('error') == 'camera', (P['logins'], j)   # (no Protect camera named Attic)
    P['deny'] = True                                  # 401 even right after a login: no second login, no loop
    rc, j, _ = run('a' * 12)
    assert P['logins'] == 3 and j == {'ev': 'clip', 'error': 'cameras'}, (P['logins'], j)
    P['deny'] = False; P['mp4'] = b'<html>nope</html>'
    rc, j, v = run('a' * 12)
    assert j == {'ev': 'clip', 'error': 'export'} and v == b'' and P['logins'] == 3
    rc, j, v = run('c' * 12)
    assert rc == 1 and j == {'ev': 'clip', 'error': 'event'} and v == b''
    os.unlink(session_path()); P['token'] = 't3'
    rc, j, _ = run('a' * 12, dict(conf, protect={'username': 'u', 'password': 'wrong'}))
    assert j == {'ev': 'clip', 'error': 'login'} and P['logins'] == 4, 'a refused login: once, said'
    rc, j, _ = run('a' * 12, {'cams': conf['cams']})
    assert j == {'ev': 'clip', 'error': 'config'} and P['logins'] == 4
    # a camera discovered with its Protect id: the export asks for it without the camera list
    P['camlists'] = 0; P['asked'] = []; P['mp4'] = open(mp4, 'rb').read()
    rc, j, _ = run('a' * 12, dict(conf, cams=[{'name': 'Door'}, {'name': 'Renamed', 'protectId': 'c1'}]))
    assert rc == 0 and P['camlists'] == 0 and 'camera=c1&' in P['asked'][0], (P, j)
    # discovery: RTSP channels kept (aliases, sizes), RTSP off listed, cameras without any left out, junk ignored
    cams, off = discover(conf)
    assert [c['name'] for c in cams] == ['Door', 'Garage'] and cams[0]['doorbell'] and not cams[1]['doorbell'], cams
    assert cams[0]['protectId'] == 'c0' and cams[0]['channels'] == [{'id': 0, 'w': 1600, 'h': 1200, 'fps': 30, 'alias': 'dOoR0'}], cams[0]
    assert [ch['alias'] for ch in cams[1]['channels']] == ['gA1', 'gA2'] and cams[1]['channels'][1]['fps'] == 30, cams[1]
    assert off == ['Door: Medium', 'Garage: bad', 'Shed: High'], off
    os.environ.pop('JAP_RIDEWATCH_PROTECT_URL')
    try:
        base({'protect': {'host': 'x/y'}}); assert False
    except ProtectError as e:
        assert e.args[0] == 'config'
    assert base({'protect': {'host': '192.0.2.1'}}) == 'https://192.0.2.1'
    srv.shutdown(); shutil.rmtree(d)
    print('clip + discovery selftest ok')


# a fake Protect camera list (field names as Protect's /proxy/protect/api/cameras gives them)
CAMERAS = [
    {'id': 'c0', 'name': 'Door', 'featureFlags': {'isDoorbell': True}, 'channels': [
        {'id': 0, 'name': 'High', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'dOoR0', 'width': 1600, 'height': 1200, 'fps': 30},
        {'id': 1, 'name': 'Medium', 'enabled': True, 'isRtspEnabled': False, 'rtspAlias': None, 'width': 1280, 'height': 960, 'fps': 30},
        {'id': 2, 'name': 'Low', 'enabled': False, 'isRtspEnabled': False, 'rtspAlias': None, 'width': 640, 'height': 480, 'fps': 30}]},
    {'id': 'c1', 'name': 'Garage', 'featureFlags': {}, 'channels': [
        {'id': 1, 'name': 'Medium', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'gA1', 'width': 1280, 'height': 720, 'fps': 24},
        {'id': 2, 'name': 'Low', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'gA2', 'width': 640, 'height': 360, 'fps': 'x'},
        {'id': 3, 'name': 'bad', 'enabled': True, 'isRtspEnabled': True, 'rtspAlias': 'a b', 'width': 640, 'height': 360}]},
    {'id': 'c2', 'name': 'Shed', 'channels': [{'id': 0, 'name': 'High', 'isRtspEnabled': False}]},
    {'name': 'no id'}, 'junk']


if __name__ == '__main__':
    selftest() if sys.argv[1:] == ['--selftest'] else main()
