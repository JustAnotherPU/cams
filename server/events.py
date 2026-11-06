#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
"""jap-cams events: the detections for the car's "What happened" timeline, read by serve.py (`events`, `thumb <id>`).

From Protect (the default, when cams.json has "protect"): every POLL_S seconds, GET /proxy/protect/api/events over
the last OVERLAP_S (an event can be written after it started) with the read-only user's session (serve.py
protect_get(): 10 s timeouts, one new login on 401/403); a ring -> "ring", a smart detection -> each of its types
(person, vehicle, animal, package); plain motion is left out. Each Protect event is taken once (its id), and only
events newer than the newest row at start (a restart adds nothing twice). A failure (Protect away, a refused login)
waits 6, 12, 24 ... s, at most 5 min, so a wrong password does not lock the account out.
From Home Assistant (optional, "events_from" + "events_token" in cams.json; examples/home-assistant.yaml):
POST :18641/event   header X-Token: <events_token>   body {"cam": "<Protect camera name>", "type": "person|vehicle|animal|package|ring"}
- Only from the HA host (`events_from`) with the events token (not a car's code).
Both: a burst = same camera + type within MERGE_S of its last hit: one row, count + 1, ts = last hit. New rows get a
320x180 JPEG grabbed from the camera's first keyframe (the subject is usually still there). Kept: KEEP_DAYS days, at
most KEEP_N rows, in /var/lib/jap-cams/events.json (+ thumbs/<id>.jpg).
"""
import http.server, json, os, re, secrets, subprocess, sys, threading, time, urllib.parse

CONF = os.environ.get('JAP_CAMS_CONF', '/opt/jap-cams/cams.json')
DIR = os.environ.get('JAP_CAMS_STATE', '/var/lib/jap-cams')
DB, THUMBS = os.path.join(DIR, 'events.json'), os.path.join(DIR, 'thumbs')
MERGE_S, KEEP_DAYS, KEEP_N = 120, 7, 500
POLL_S, OVERLAP_S, BACKOFF_MAX = 3, 120, 300
TYPES = ('person', 'vehicle', 'animal', 'package', 'ring')
lock = threading.Lock()


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import serve  # noqa: E402  (the Protect session, the cameras' urls)


def load():
    try:
        return json.load(open(DB))
    except (OSError, ValueError):
        return []


def save(evs):
    tmp = DB + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(evs, f)
    os.replace(tmp, DB)                    # readers (serve.py) never see a half-written file


def add(evs, cams, name, typ, now):
    """merge or append; returns (row, is_new) or (None, False) for an unknown camera/type"""
    i = next((k for k, c in enumerate(cams) if c['name'] == name), None)
    if i is None or typ not in TYPES:
        return None, False
    for e in reversed(evs):
        if e['cam'] == i and e['type'] == typ and now - e['ts'] <= MERGE_S * 1000:
            e['count'] += 1; e['ts'] = now
            return e, False
    e = {'id': secrets.token_hex(6), 'cam': i, 'label': cams[i].get('label', name), 'type': typ, 'ts': now,
         'first': now, 'count': 1, 'thumb': False}
    evs.append(e)
    cut = now - KEEP_DAYS * 86400000
    for old in [x for x in evs if x['ts'] < cut] + evs[:max(0, len(evs) - KEEP_N)]:
        if old in evs:
            evs.remove(old)
            try:
                os.unlink(os.path.join(THUMBS, old['id'] + '.jpg'))
            except OSError:
                pass
    return e, True


def grab(cam, eid):
    """first keyframe of the medium channel -> 320x180 JPEG; marks the row when done"""
    ch = serve.channel(cam, 320, 180, True)
    big = [c for c in cam['channels'] if c.get('url')] or [ch]
    out = os.path.join(THUMBS, eid + '.jpg')
    r = subprocess.run(['timeout', '15', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                        '-rtsp_transport', 'tcp', '-skip_frame', 'nokey'] + serve.PROBE + ['-i', serve.src_url(big[0]),
                        '-map', '0:v:0', '-frames:v', '1', '-vf', serve.cover(320, 180), '-q:v', '4', out],
                       stdin=subprocess.DEVNULL, capture_output=True)
    if r.returncode == 0 and os.path.getsize(out) > 0:
        with lock:
            evs = load()
            for e in evs:
                if e['id'] == eid:
                    e['thumb'] = True
            save(evs)
    else:
        sys.stderr.write('thumb %s failed: %s\n' % (eid, r.stderr.decode(errors='replace')[-200:]))


def record(cams, name, typ, ts, grab_=None):
    """one hit into the timeline; a new row gets its picture (in a thread)"""
    with lock:
        evs = load()
        e, new = add(evs, cams, name, typ, ts)
        if e:
            save(evs)
    if e and new:
        threading.Thread(target=grab_ or grab, args=(cams[e['cam']], e['id']), daemon=True).start()
    return e


def hits(ev):
    """the timeline types of one Protect event"""
    if ev.get('type') == 'ring':
        return ['ring']
    if ev.get('type') in ('smartDetectZone', 'smartDetectLine'):
        return [t for t in TYPES if t != 'ring' and t in (ev.get('smartDetectTypes') or [])]
    return []


def poll_once(conf, st, now):
    """[(camera name, type, ts)] of the Protect events not seen yet; st: {"floor", "seen"} kept between polls"""
    ids = {c.get('protectId'): c['name'] for c in conf['cams'] if c.get('protectId')}
    q = [('start', max(st['floor'], now - OVERLAP_S * 1000)), ('end', now), ('limit', 200), ('orderDirection', 'ASC')]
    q += [('types', t) for t in ('ring', 'smartDetectZone', 'smartDetectLine')]
    try:
        rows = json.loads(serve.protect_get(conf, '/proxy/protect/api/events?' + urllib.parse.urlencode(q)))
        if not isinstance(rows, list):
            raise ValueError
    except ValueError:
        raise serve.ProtectError('events', 'events: not a JSON list')
    out = []
    for ev in rows:
        if not isinstance(ev, dict) or not isinstance(ev.get('id'), str) or not isinstance(ev.get('start'), int):
            continue
        cam = ev.get('camera')
        name = ids.get(cam.get('id') if isinstance(cam, dict) else cam)
        if name is None or ev['start'] <= st['floor']:
            continue
        for t in hits(ev):
            if (ev['id'], t) not in st['seen']:
                st['seen'][(ev['id'], t)] = ev['start']
                out.append((name, t, ev['start']))
    for k in [k for k, ts in st['seen'].items() if ts < now - 2 * OVERLAP_S * 1000]:
        del st['seen'][k]
    return sorted(out, key=lambda x: x[2])


def poller(sleep=time.sleep, polls=None, grab_=None, clock=time.time):
    """polls Protect for ever (polls: that many times, for the selftest)"""
    rows = load()
    st = {'floor': max([e['ts'] for e in rows] + [int(clock() * 1000) - 600000]), 'seen': {}}
    fails, n = 0, 0
    while polls is None or n < polls:
        n += 1
        try:
            conf = json.load(open(CONF))
            serve.use(conf)
            for name, t, ts in poll_once(conf, st, int(clock() * 1000)):
                record(conf['cams'], name, t, ts, grab_)
            fails = 0
        except serve.ProtectError as e:
            fails += 1
            sys.stderr.write('protect events: %s\n' % e.args[1])
        except (OSError, ValueError, KeyError) as e:
            fails += 1
            sys.stderr.write('protect events: cams.json: %s\n' % e)
        sleep(min(BACKOFF_MAX, POLL_S * 2 ** fails) if fails else POLL_S)


class H(http.server.BaseHTTPRequestHandler):
    timeout = 10                                      # a half-sent request does not keep its thread

    def do_POST(self):
        conf = json.load(open(CONF))
        if (self.path != '/event' or self.client_address[0] != conf.get('events_from')
                or not secrets.compare_digest(self.headers.get('X-Token', ''), conf.get('events_token', '-'))):
            self.send_response(403); self.end_headers(); return
        try:
            body = json.loads(self.rfile.read(max(0, min(int(self.headers.get('Content-Length', 0)), 4096))))
            name, typ = str(body['cam']), str(body['type'])
        except (ValueError, KeyError, TypeError):
            self.send_response(400); self.end_headers(); return
        serve.use(conf)
        e = record(conf['cams'], name, typ, int(time.time() * 1000))
        self.send_response(204 if e else 422); self.end_headers()

    def log_message(self, fmt, *a):
        pass                               # no per-request journal lines


def selftest():
    cams = [{'name': 'Garage', 'label': 'Garage'}, {'name': 'Door', 'label': 'Front door'}]
    evs = []
    e, new = add(evs, cams, 'Garage', 'person', 1000000)
    assert new and e['count'] == 1 and e['label'] == 'Garage' and re.fullmatch(r'[0-9a-f]{12}', e['id'])
    e2, new = add(evs, cams, 'Garage', 'person', 1000000 + 60000)
    assert not new and e2 is e and e['count'] == 2 and e['ts'] == 1060000
    _, new = add(evs, cams, 'Garage', 'person', 1060000 + MERGE_S * 1000 + 1)
    assert new and len(evs) == 2                                   # past the burst window: a new row
    _, new = add(evs, cams, 'Garage', 'vehicle', 1060001)
    assert new and len(evs) == 3                                   # another type: its own row
    assert add(evs, cams, 'Nope', 'person', 1)[0] is None and add(evs, cams, 'Garage', 'motion', 1)[0] is None
    big = []
    for k in range(KEEP_N + 5):
        add(big, cams, 'Garage' if k % 2 else 'Door', 'ring', k * MERGE_S * 2000)
    assert len(big) == KEEP_N
    poll_selftest()
    print('selftest ok')


def poll_selftest():
    """the Protect poller against a fake Protect (http://127.0.0.1): mapping, once per event, the floor, the backoff"""
    import shutil, tempfile
    global DIR, DB, THUMBS, CONF
    d = tempfile.mkdtemp(); DIR, DB, THUMBS = d, os.path.join(d, 'events.json'), os.path.join(d, 'thumbs')
    serve.STATE = d; CONF = os.path.join(d, 'cams.json')
    now = [1762300000000]
    P = {'events': [], 'asked': [], 'down': False}

    class Fake(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, st, body=b'', hdr=()):
            self.send_response(st)
            for k, v in hdr:
                self.send_header(k, v)
            self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers['Content-Length']))
            self.reply(200, b'{}', [('Set-Cookie', 'TOKEN=t; path=/'), ('X-CSRF-Token', 'c')])

        def do_GET(self):
            if P['down']:
                return self.reply(502)
            if self.headers.get('Cookie') != 'TOKEN=t':
                return self.reply(401)
            u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
            P['asked'].append(q)
            if u.path != '/proxy/protect/api/events':
                return self.reply(404)
            lo, hi = int(q['start'][0]), int(q['end'][0])
            self.reply(200, json.dumps([e for e in P['events'] if not isinstance(e, dict) or lo <= e.get('start', lo) <= hi]).encode())
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    os.environ['JAP_CAMS_PROTECT_URL'] = 'http://127.0.0.1:%d' % srv.server_address[1]
    json.dump({'protect': {'host': '192.0.2.1', 'username': 'u', 'password': 'p'},
               'cams': [{'name': 'Door', 'protectId': 'c0', 'channels': []}, {'name': 'Garage', 'protectId': 'c1', 'channels': []}]}, open(CONF, 'w'))
    t0 = now[0]
    P['events'] = [
        {'id': 'old', 'type': 'ring', 'camera': 'c0', 'start': t0 - 700000},                 # before the floor
        {'id': 'r1', 'type': 'ring', 'camera': 'c0', 'start': t0 - 5000, 'end': t0 - 4000},
        {'id': 's1', 'type': 'smartDetectZone', 'camera': 'c1', 'start': t0 - 3000, 'end': None, 'smartDetectTypes': ['vehicle', 'person']},
        {'id': 'm1', 'type': 'motion', 'camera': 'c1', 'start': t0 - 2000},                  # plain motion: not listed
        {'id': 'x1', 'type': 'smartDetectZone', 'camera': 'c9', 'start': t0 - 2000, 'smartDetectTypes': ['person']},   # unknown camera
        {'id': 'l1', 'type': 'smartDetectLine', 'camera': {'id': 'c0'}, 'start': t0 - 1000, 'smartDetectTypes': ['licensePlate', 'animal']},
        'junk', {'id': 'nostart', 'type': 'ring', 'camera': 'c0'}]
    grabbed, waits = [], []
    clock = lambda: now[0] / 1000
    def step(s):
        waits.append(s); now[0] += 3000
    poller(sleep=step, polls=1, grab_=lambda cam, eid: grabbed.append(cam['name']), clock=clock)
    rows = load()
    assert [(r['cam'], r['type'], r['ts']) for r in rows] == [(0, 'ring', t0 - 5000), (1, 'person', t0 - 3000), (1, 'vehicle', t0 - 3000),
                                                             (0, 'animal', t0 - 1000)], rows
    q = P['asked'][-1]
    assert q['types'] == ['ring', 'smartDetectZone', 'smartDetectLine'] and q['orderDirection'] == ['ASC'] and int(q['end'][0]) == t0, q
    # the same events again (the window overlaps) and a detection added to an ongoing one: only the new type
    P['events'][2]['smartDetectTypes'].append('package')
    poller(sleep=step, polls=1, grab_=lambda cam, eid: grabbed.append(cam['name']), clock=clock)
    rows = load()
    assert [(r['type'], r['count']) for r in rows] == [('ring', 1), ('person', 1), ('vehicle', 1), ('animal', 1)], rows
    assert len(P['asked']) == 2
    # a restart: the floor is the newest row, so nothing is added twice
    poller(sleep=step, polls=1, grab_=lambda cam, eid: grabbed.append(cam['name']), clock=clock)
    assert len(load()) == 4 and sorted(grabbed) == ['Door', 'Door', 'Garage', 'Garage'], grabbed
    # Protect away: backoff 6, 12 s ..., back to 3 s once it answers
    P['down'] = True; waits.clear()
    poller(sleep=step, polls=3, clock=clock)
    assert waits == [6, 12, 24], waits
    P['down'] = False; waits.clear()
    poller(sleep=step, polls=1, clock=clock)
    assert waits == [3], waits
    os.environ.pop('JAP_CAMS_PROTECT_URL'); srv.shutdown(); shutil.rmtree(d)
    print('poll selftest ok')


if __name__ == '__main__':
    if sys.argv[1:] == ['--selftest']:
        selftest()
    else:
        os.makedirs(THUMBS, exist_ok=True)
        conf = json.load(open(CONF))
        ha = conf.get('events_from') and conf.get('events_token')
        if conf.get('protect') and conf.get('events_protect', True):
            threading.Thread(target=poller, daemon=True).start()
        if ha:
            http.server.ThreadingHTTPServer(('0.0.0.0', 18641), H).serve_forever()
        threading.Event().wait()                      # the poller alone: keep the process
