'use strict';
// jap-cams daemon offline test: a fake SOCKS5 + jap-cams server (serve.py's protocol, mosaic2's layout line, a few bytes of
// fake Annex-B) and a fake camdec (test/fake_camdec.js). Covers list, view, switch, drop + reconnect, last client gone,
// and concept A: the event feed, the hero (chooseHero, isNight), spot streams following the hero, pick, ring, thumbs,
// an event's clip (played once -> ended, never reconnected; a server error -> its message), the app's config and
// the car's code.
//   node test/camsd_test.js            (Node 22 like the car: docker run --rm --network none -v $PWD:/w -w /w node:22.12.0-alpine node test/camsd_test.js)
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camsd-'));
const CTL = path.join(tmp, 'ctl.sock'), CONF = path.join(tmp, 'server.json'), DLOG = path.join(tmp, 'camdec.log');
const TOKEN = 'tok-' + Math.random().toString(36).slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) { const end = Date.now() + (ms || 5000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); } }

/* ---- fake SOCKS5 + server: CONNECT to 192.0.2.10:18640, then serve.py's protocol on the same socket ---- */
const LAYOUT = { w: 1920, h: 720, hero: 2, tiles: [{ i: 0, x: 0, y: 0, w: 960, h: 720 }, { i: 1, x: 960, y: 0, w: 960, h: 360 }, { i: 2, x: 960, y: 360, w: 960, h: 360 }] };
// fake names; roles as server/configure.py writes them: 0 the door (and night), 1 the garage, 3 the day camera
const ROLES = { 0: ['door', 'night'], 1: ['garage'], 3: ['day'] };
const CAMS = ['Door', 'Garage', 'Yard', 'Drive', 'Street', 'Side', 'Garden', 'Patio 360', 'Shed', 'Porch', 'Attic']
    .map((label, i) => ({ i, name: 'Cam ' + i, label, shape: i ? 'wide' : 'tall', w: i ? 1280 : 1440, h: i ? 720 : 1920, roles: ROLES[i] || [] }));
const SPOT = (h) => ({ ev: 'layout', w: 1920, h: 720, hero: h, heroRect: { x: 0, y: 0, w: 1280, h: 720 }, pane: { x: 1280, y: 0, w: 640, h: 720 },
    tiles: CAMS.filter((c) => c.i !== h).slice(0, 10).map((c, k) => (k < 6 ? { x: 1280 + (k % 2) * 320, y: Math.floor(k / 2) * 180, w: 320, h: 180, shape: 'wide' }
        : k === 6 ? { x: 1280, y: 540, w: 136, h: 180, shape: 'tall' } : { x: 1424 + (k - 7) * 168, y: 550, w: 160, h: 160, shape: 'round' })).map((t, k) => Object.assign({ i: CAMS.filter((c) => c.i !== h)[k].i, name: 'x', label: CAMS.filter((c) => c.i !== h)[k].label }, t)) });
const JPEG = fs.readFileSync(path.join(__dirname, 'fixtures', 'thumb.jpg'));
const srv = { conns: [], refuse: 0, delay: 300, evs: [], events: [] };
function nalu(type, tag, seq, len) {
    const head = Buffer.from(String.fromCharCode(type) + tag + ',' + seq + ',' + (len + 1) + '.', 'latin1');   // +1: the type byte
    return Buffer.concat([Buffer.from([0, 0, 0, 1]), head, Buffer.alloc(len + 1 - head.length, '.')]);
}
function stream(s, tag, conn) {
    let seq = 0;
    // one frame each 40 ms, each write cut in two at a random byte (TCP chunking anywhere)
    const put = (b) => { const k = 1 + Math.floor(Math.random() * (b.length - 1)); s.write(b.slice(0, k)); s.write(b.slice(k)); };
    const gop = () => { put(nalu(0x67, tag, seq++, 20)); put(nalu(0x68, tag, seq++, 8)); put(nalu(0x65, tag, seq++, 3000)); };
    const t0 = setTimeout(() => {
        if (s.destroyed) return;
        conn.idrAt = Date.now();
        gop();
        conn.timer = setInterval(() => { if (seq % 25 === 0) gop(); else put(nalu(0x41, tag, seq++, 700)); }, 40);
    }, srv.delay);
    s.on('close', () => { clearTimeout(t0); clearInterval(conn.timer); });
}
const server = net.createServer((s) => {
    let st = 0, buf = Buffer.alloc(0);
    const conn = { req: null, open: Date.now(), closed: null, s };
    srv.conns.push(conn);
    s.on('close', () => { conn.closed = Date.now(); });
    s.on('error', () => {});
    s.on('data', function on(d) {
        buf = Buffer.concat([buf, d]);
        if (st === 0 && buf.length >= 3) { assert.deepStrictEqual([...buf.slice(0, 3)], [5, 1, 0]); buf = buf.slice(3); s.write(Buffer.from([5, 0])); st = 1; }
        if (st === 1 && buf.length >= 10) {
            assert.deepStrictEqual([...buf.slice(0, 10)], [5, 1, 0, 1, 192, 0, 2, 10, 18640 >> 8, 18640 & 255], 'SOCKS CONNECT to the server');
            buf = buf.slice(10); s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); st = 2;
        }
        const k = st === 2 ? buf.indexOf(10) : -1;
        if (k < 0) return;
        s.removeListener('data', on);
        const w = buf.slice(0, k).toString().split(' ');
        conn.req = w.slice(1).join(' ');
        const video = /^(mosaic2|cam|spot|clip)$/.test(w[1]);
        if (w[0] !== TOKEN || (video && srv.refuse > 0)) { if (video && srv.refuse > 0) srv.refuse--; return s.end(); }   // serve.py: close without a word
        if (w[1] === 'list') return s.end(JSON.stringify(CAMS) + '\n');
        if (w[1] === 'events') { srv.evs.push(s); return s.write(JSON.stringify({ ev: 'events', list: srv.events }) + '\n'); }
        if (w[1] === 'thumb') { srv.thumbs = (srv.thumbs || 0) + 1; return s.end(w[2] === 'e-jpeg' ? JPEG : Buffer.alloc(0)); }
        if (w[1] === 'spot') { const l = JSON.stringify(SPOT(+w[2])); s.write(l.slice(0, 33)); s.write(l.slice(33) + '\n'); return stream(s, 'S' + w[2], conn); }
        if (w[1] === 'mosaic2') { s.write(JSON.stringify(LAYOUT).slice(0, 10)); s.write(JSON.stringify(LAYOUT).slice(10) + '\n'); return stream(s, 'M', conn); }
        if (w[1] === 'cam') return stream(s, 'C' + w[2], conn);
        if (w[1] === 'clip' && w[2] === 'e-err') return s.end(JSON.stringify({ ev: 'clip', error: 'export' }) + '\n');
        if (w[1] === 'clip') {                         // the line in two writes, ~0.7 s of stream, then the server closes
            const l = JSON.stringify({ ev: 'clip', id: w[2], cam: 6, label: 'Garden', type: 'person', start: 1000, dur: 700 });
            s.write(l.slice(0, 20)); s.write(l.slice(20) + '\n');
            stream(s, 'K', conn);
            return setTimeout(() => { clearInterval(conn.timer); s.end(); }, srv.delay + 700);
        }
        s.end();
    });
});

/* ---- the daemon, and an app on ctl.sock ---- */
let daemon, out = '';
function startDaemon(port) {
    daemon = cp.spawn(process.execPath, [path.join(__dirname, '..', 'camsd.js')], {
        env: Object.assign({}, process.env, { JAP_CAMS_CONF: CONF, JAP_CAMS_CTL: CTL, JAP_CAMDEC: path.join(__dirname, 'fake_camdec.js'),
            JAP_CAMS_VIDEO: path.join(tmp, 'jap-video-cams'), MGU_UPLINK: path.join(tmp, 'status.json'), FAKE_CAMDEC_LOG: DLOG, FAKE_STATS_MS: '300' }),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout.on('data', (d) => { out += d; });
    daemon.stderr.on('data', (d) => { out += d; });
}
function app() {
    const a = { evs: [], s: net.createConnection(CTL) };
    let b = '';
    a.s.setEncoding('utf8');
    a.s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) >= 0) { a.evs.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } });
    a.send = (o) => a.s.write(JSON.stringify(o) + '\n');
    a.of = (ev) => a.evs.filter((e) => e.ev === ev);
    a.states = () => a.of('state').map((e) => e.state);
    return a;
}
const nals = () => (fs.existsSync(DLOG) ? fs.readFileSync(DLOG, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
const streams = () => srv.conns.filter((c) => /^(mosaic2|cam|spot|clip) /.test(c.req || ''));
const push = (e) => srv.evs.filter((s) => !s.destroyed).forEach((s) => s.write(JSON.stringify(Object.assign({ ev: 'event' }, e)) + '\n'));

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    fs.writeFileSync(CONF, JSON.stringify({ host: '192.0.2.10', port: 18640, token: TOKEN, socks: '127.0.0.1:' + port }), { mode: 0o644 });
    fs.chmodSync(CONF, 0o644);
    startDaemon();
    await until(() => fs.existsSync(CTL), 'ctl.sock');
    const a = app();
    await new Promise((r) => a.s.on('connect', r));

    // status, list
    a.send({ cmd: 'status' });
    await until(() => a.of('state').length, 'status reply');
    assert.deepStrictEqual(a.of('state')[0], { ev: 'state', state: 'idle', view: null, msg: null, shows: null });
    a.send({ cmd: 'list' });
    await until(() => a.of('list').length, 'list');
    assert.deepStrictEqual(a.of('list')[0].cams.map((c) => c.label), CAMS.map((c) => c.label));
    assert.deepStrictEqual(a.of('list')[0].cams[0], CAMS[0], 'list: shape and size passed on');
    assert.strictEqual(fs.statSync(CONF).mode & 0o777, 0o600, 'server.json made 0600');
    console.log('ok list');

    // view mosaic: mosaic2, the layout line, connecting -> playing, camdec gets the stream from its SPS, stats + kbps
    a.send({ cmd: 'view', view: 'mosaic', rect: '1920x720' });
    await until(() => a.states().indexOf('playing') >= 0, 'mosaic playing');
    assert.deepStrictEqual(a.states().slice(1), ['connecting', 'playing']);
    assert.strictEqual(streams()[0].req, 'mosaic2 1920x720');
    const L0 = a.of('layout')[0];
    assert.deepStrictEqual([L0.w, L0.h, L0.hero, L0.tiles.map((t) => [t.i, t.x, t.y, t.w, t.h, t.shape])], [1920, 720, 2, LAYOUT.tiles.map((t) => [t.i, t.x, t.y, t.w, t.h, 'wide'])], 'layout from the server line');
    await until(() => a.of('stats').length >= 2, 'stats');
    const stt = a.of('stats').slice(-1)[0];
    assert.ok(stt.kbps > 0 && stt.decoded > 0 && 'decode_ms' in stt, 'stats with kbps: ' + JSON.stringify(stt));
    const n0 = nals().filter((l) => l[1] !== 'start');
    assert.deepStrictEqual(n0.slice(0, 3).map((l) => l[1] + l[2]), ['7M', '8M', '5M'], 'camdec starts at SPS, PPS, IDR');
    const pid = +nals()[0][0];
    console.log('ok view mosaic (layout, playing, stats ' + stt.kbps + ' kbps)');

    // a double press: nothing new
    a.send({ cmd: 'view', view: 'mosaic', rect: '1920x720' });
    await sleep(200);
    assert.strictEqual(streams().length, 1, 'same view: no new connection');

    // switch: cam 1 opened first, the mosaic kept until cam 1's first IDR, one camdec, whole NALs only
    srv.delay = 600;
    a.send({ cmd: 'view', view: 1, rect: '1920x720' });
    await until(() => streams().length === 2, 'second connection');
    const [m, c1] = streams();
    assert.strictEqual(c1.req, 'cam 1 1920x720');
    await sleep(300);
    assert.deepStrictEqual([a.states().slice(-1)[0], a.of('state').slice(-1)[0].shows], ['connecting', 'mosaic'], 'shows: the old view meanwhile');
    assert.strictEqual(m.closed, null, 'mosaic still open while cam 1 connects');
    await until(() => a.states().slice(-1)[0] === 'playing', 'cam 1 playing');
    await until(() => m.closed, 'mosaic closed');
    assert.strictEqual(a.of('state').slice(-1)[0].shows, 1, 'shows: cam 1 once it plays');
    assert.ok(m.closed >= c1.idrAt, 'old closed after the new IDR (' + (m.closed - c1.idrAt) + ' ms)');
    await sleep(300);
    const n1 = nals().filter((l) => l[1] !== 'start');
    const first = n1.findIndex((l) => l[2] === 'C1');
    assert.deepStrictEqual(n1.slice(first, first + 3).map((l) => l[1] + l[2]), ['7C1', '8C1', '5C1'], 'cam 1 from its SPS');
    assert.ok(n1.slice(first).every((l) => l[2] === 'C1'), 'no mosaic bytes after the switch');
    assert.ok(n1.every((l) => l[4] === 'ok'), 'every NAL whole: ' + n1.filter((l) => l[4] !== 'ok').map((l) => l.join(' ')).join(', '));
    assert.ok(nals().every((l) => +l[0] === pid), 'one camdec through the switch');
    console.log('ok switch (old kept ' + (m.closed - c1.open) + ' ms, closed ' + (m.closed - c1.idrAt) + ' ms after the new IDR)');

    // drop: the server goes; error, reconnect after 1 s; refused once -> next after 2 s; then playing again
    srv.delay = 100; srv.refuse = 1;
    const k0 = a.evs.length, tDrop = Date.now();
    c1.s.destroy();
    await until(() => streams().length === 4 && a.states().slice(-1)[0] === 'playing', 'reconnected', 8000);
    const [r1, r2] = streams().slice(2);
    assert.ok(r1.open - tDrop >= 900 && r1.open - tDrop < 1600, 'first retry ~1 s: ' + (r1.open - tDrop));
    assert.ok(r2.open - r1.open >= 1900 && r2.open - r1.open < 2700, 'second retry ~2 s: ' + (r2.open - r1.open));
    assert.strictEqual(r2.req, 'cam 1 1920x720');
    const ev = a.evs.slice(k0).filter((e) => e.ev === 'state');
    assert.ok(/connection lost - retry in 1 s/.test(ev[0].msg) && ev[0].state === 'error', JSON.stringify(ev[0]));
    assert.ok(ev.some((e) => e.state === 'error' && e.msg === 'Server refused this car: add code ' + TOKEN + ' on the server - retry in 2 s'), 'refused message');
    assert.ok(nals().every((l) => +l[0] === pid), 'camdec kept through the drop (its last frame stays)');
    console.log('ok drop + reconnect (' + (r1.open - tDrop) + ' ms, then ' + (r2.open - r1.open) + ' ms)');

    // last app gone: the stream and camdec stop within 2 s
    const tGone = Date.now();
    a.s.destroy();
    await until(() => r2.closed && !alive(pid) && srv.evs.every((s) => s.destroyed), 'stopped (stream, camdec, event feed)', 2000);
    assert.ok(nals().some((l) => l[1] === 'eof'), 'camdec saw stdin EOF');
    console.log('ok last client gone (stream closed in ' + (r2.closed - tGone) + ' ms, camdec gone)');
    await sleep(1500);
    assert.strictEqual(streams().length, 4, 'nothing reconnects after the stop');

    // a wrong token: refused, said so, the token never in the log
    fs.writeFileSync(CONF, JSON.stringify({ host: '192.0.2.10', port: 18640, token: 'nope', socks: '127.0.0.1:' + port }), { mode: 0o600 });
    const b = app();
    await new Promise((r) => b.s.on('connect', r));
    b.send({ cmd: 'list' });
    await until(() => b.of('error').length, 'list error');
    assert.deepStrictEqual(b.of('error')[0], { ev: 'error', cmd: 'list', msg: 'server refused this car' });
    b.send({ cmd: 'view', view: 7, rect: '1921x720' });
    await until(() => b.of('error').length === 2, 'bad rect refused');
    b.s.destroy();
    assert.ok(out.indexOf(TOKEN) < 0 && out.indexOf('nope') < 0, 'token never logged');
    console.log('ok bad token / bad rect; token not in the log');

    // socksFallback: the main SOCKS port is dead (that tunnel is down): the list still comes through the fallback
    const dead = net.createServer(); await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = dead.address().port; await new Promise((r) => dead.close(r));
    fs.writeFileSync(CONF, JSON.stringify({ host: '192.0.2.10', port: 18640, token: TOKEN, socks: '127.0.0.1:' + deadPort, socksFallback: '127.0.0.1:' + port }), { mode: 0o600 });
    const f = app();
    await new Promise((r) => f.s.on('connect', r));
    f.send({ cmd: 'list' });
    await until(() => f.of('list').length || f.of('error').length, 'list through the fallback');
    assert.deepStrictEqual(f.of('error'), [], 'no error with a fallback');
    assert.strictEqual(f.of('list')[0].cams.length, CAMS.length);
    assert.ok(out.indexOf('tunnel ' + deadPort + ': ') >= 0 && out.indexOf('trying ' + port) >= 0, 'the switch is logged');
    f.s.destroy();
    fs.writeFileSync(CONF, JSON.stringify({ host: '192.0.2.10', port: 18640, token: TOKEN, socks: '127.0.0.1:' + port, socksFallback: 'nonsense' }), { mode: 0o600 });
    const g = app();
    await new Promise((r) => g.s.on('connect', r));
    g.send({ cmd: 'list' });
    await until(() => g.of('error').length, 'bad fallback refused');
    assert.ok(/socks host:port/.test(g.of('error')[0].msg), g.of('error')[0].msg);
    g.s.destroy();
    console.log('ok socksFallback (dead main port -> fallback, logged; a bad fallback refused)');

    // first start: no server.json -> the car's code is made (0600), the view says to set the address
    fs.unlinkSync(CONF);
    const k = app();
    await new Promise((r) => k.s.on('connect', r));
    k.send({ cmd: 'view', view: 'mosaic', rect: '1920x720' });
    await until(() => k.of('state').some((e) => e.state === 'error'), 'no address');
    assert.ok(/^no server address: set it in Settings - retry in 1 s$/.test(k.of('state').find((e) => e.state === 'error').msg));
    k.send({ cmd: 'stop' });
    const made = JSON.parse(fs.readFileSync(CONF, 'utf8'));
    assert.ok(/^([A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/.test(made.token) && fs.statSync(CONF).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(CONF).mode & 0o777, 0o600, 'server.json 0600');
    assert.ok(out.indexOf(made.token) < 0, 'the code is not logged');
    // the app's settings: merged into server.json, the code kept; 0.0.0.0 keeps the address; nonsense refused
    k.send({ cmd: 'config', host: [192, 0, 2, 10], port: 18640, socks: port, socksFallback: 1055, lat: 51, lon: -2 });
    await until(() => JSON.parse(fs.readFileSync(CONF, 'utf8')).host === '192.0.2.10', 'config written');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(CONF, 'utf8')), { token: made.token, host: '192.0.2.10', port: 18640, socks: '127.0.0.1:' + port,
        socksFallback: '127.0.0.1:1055', lat: 51, lon: -2 });
    k.send({ cmd: 'config', host: [0, 0, 0, 0], port: 18640, socks: port, socksFallback: 0, lat: 0, lon: 0 });
    await until(() => !('socksFallback' in JSON.parse(fs.readFileSync(CONF, 'utf8'))), 'config again');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(CONF, 'utf8')), { token: made.token, host: '192.0.2.10', port: 18640, socks: '127.0.0.1:' + port });
    k.send({ cmd: 'config', host: [300, 0, 0, 1], port: 18640, socks: port, socksFallback: 0, lat: 0, lon: 0 });
    await until(() => k.of('error').some((e) => e.cmd === 'config'), 'bad config refused');
    // the server does not know this code yet: the list is refused; once added there (here: the fake's token), it works
    k.send({ cmd: 'list' });
    await until(() => k.of('error').some((e) => e.cmd === 'list'), 'unknown code refused');
    fs.writeFileSync(CONF, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(CONF, 'utf8')), { token: TOKEN })), { mode: 0o600 });
    k.send({ cmd: 'list' });
    await until(() => k.of('list').length, 'list with the added code');
    assert.deepStrictEqual(k.of('list')[0].cams[1].roles, ['garage'], 'roles passed on');
    k.s.destroy();
    console.log('ok first start (code made, 0600, not logged), config from the app, refused until added');

    /* ---- concept A ---- */
    const { chooseHero, isNight, scale } = require('../camsd.js');
    assert.strictEqual(isNight(new Date('2026-11-05T12:00:00Z'), 51, 0), false, '51N 0E noon: day');
    assert.strictEqual(isNight(new Date('2026-11-05T17:30:00Z'), 51, 0), true, '51N 0E 17:30 UTC in November: night');
    assert.strictEqual(isNight(new Date('2026-06-21T19:30:00Z'), 51, 0), false, '51N 0E 19:30 UTC in June: day');
    assert.strictEqual(isNight(new Date('2026-06-21T03:00:00Z'), 51, 0), true, '51N 0E 03:00 UTC in June: night');
    const now = Date.UTC(2026, 10, 5, 12), E = (cam, type, ago) => ({ cam, type, ts: now - ago });
    const H = (evs, pick, home, night) => { const h = chooseHero(evs, CAMS, pick === undefined ? null : pick, home === undefined ? null : home, now, !!night); return h.hero + ' ' + h.why; };
    assert.strictEqual(H([]), '3 default', 'day: the day camera');
    assert.strictEqual(H([], null, null, true), '0 default', 'night: the night camera');
    assert.strictEqual(H([E(6, 'motion', 1000)]), '3 default', 'plain motion: no hero');
    assert.strictEqual(H([E(6, 'animal', 9 * 60000)]), '6 event', 'animal 9 min ago');
    assert.strictEqual(H([E(6, 'animal', 11 * 60000)]), '3 default', 'over 10 min: gone');
    assert.strictEqual(H([E(6, 'animal', 60000), E(1, 'vehicle', 1000)], null, true), '6 event', 'Garage skipped while home');
    assert.strictEqual(H([E(1, 'vehicle', 1000)], null, false), '1 event', 'Garage away from home');
    assert.strictEqual(H([E(1, 'vehicle', 1000)], null, null), '1 event', 'Garage, home unknown');
    assert.strictEqual(H([E(6, 'animal', 1000)], 8), '8 picked', 'a pick beats an event');
    assert.strictEqual(H([E(0, 'person', 1000)]), '0 person', 'a person at the door camera');
    assert.strictEqual(H([E(0, 'person', 1000)], 8), '8 picked', 'a person at the door does not override a pick');
    assert.strictEqual(H([E(5, 'ring', 1000)], 8), '0 ring', 'a ring overrides a pick');
    assert.strictEqual(H([E(5, 'ring', 3 * 60000)], 8), '8 picked', 'a ring over 2 min ago');

    // no roles at all: the first camera by default, a ring on its own camera, a person anywhere is a plain event
    const bare = CAMS.map((x) => Object.assign({}, x, { roles: [] }));
    const B = (evs, night) => { const h = chooseHero(evs, bare, null, null, now, !!night); return h.hero + ' ' + h.why; };
    assert.strictEqual(B([]), '0 default', 'no roles: camera 0');
    assert.strictEqual(B([], true), '0 default', 'no roles, night: camera 0');
    assert.strictEqual(B([E(5, 'ring', 1000)]), '5 ring', 'no door camera: the ringing one');
    assert.strictEqual(B([E(0, 'person', 1000)]), '0 event', 'no door camera: a person is an event');
    assert.strictEqual(H([], null, null, true).split(' ')[0], '0', 'night with a night camera');
    const dayOnly = CAMS.map((x) => Object.assign({}, x, { roles: x.i === 3 ? ['day'] : [] }));
    assert.strictEqual(chooseHero([], dayOnly, null, null, now, true).hero, 3, 'night without a night camera: the day one');
    const { newCode } = require('../camsd.js');
    assert.ok(/^([A-HJ-NP-Z2-9]{4}-){3}[A-HJ-NP-Z2-9]{4}$/.test(newCode()) && newCode() !== newCode(), 'car code: 4 x 4, no 0/O/1/I');
    const sc = scale({ width: 4, height: 2, data: Buffer.from([0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0, 255, 255, 255, 0]) });
    assert.strictEqual(sc.length, 160 * 90 * 4, 'thumbs are 160x90 RGBA');
    console.log('ok chooseHero / isNight / scale');

    const UPL = path.join(tmp, 'status.json');
    fs.writeFileSync(UPL, JSON.stringify({ wifi: { link: 'online', ssid: 'Home' } }));
    fs.writeFileSync(CONF, JSON.stringify({ host: '192.0.2.10', port: 18640, token: TOKEN, socks: '127.0.0.1:' + port, homeSsid: 'Home' }), { mode: 0o600 });
    const t = Date.now();
    srv.events = [{ id: 'e-old', cam: 4, label: 'Street', type: 'person', ts: t - 3600000, count: 1, thumb: false },
        { id: 'e-jpeg', cam: 5, label: 'Side', type: 'vehicle', ts: t - 60000, count: 2, thumb: true }];
    srv.evs = []; srv.delay = 300;
    const n0s = streams().length;
    const c = app();
    await new Promise((r) => c.s.on('connect', r));
    c.send({ cmd: 'list' });
    await until(() => c.of('hero').some((h) => h.hero === 5), 'hero from the listed vehicle');
    const h0 = c.of('hero').slice(-1)[0];
    assert.deepStrictEqual([h0.hero, h0.why, h0.home, h0.event.id], [5, 'event', true, 'e-jpeg'], JSON.stringify(h0));
    assert.deepStrictEqual(c.of('events')[0].list.map((e) => e.id), ['e-old', 'e-jpeg'], 'the feed\'s list, newest last');
    c.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    await until(() => c.states().slice(-1)[0] === 'playing', 'spot playing');
    const sp5 = streams()[n0s];
    assert.strictEqual(sp5.req, 'spot 5 1920x720');
    const L5 = c.of('layout').slice(-1)[0];
    assert.deepStrictEqual([L5.hero, L5.heroRect, L5.pane.x, L5.tiles.length, L5.tiles[0].label, L5.tiles.map((x) => x.shape).join(',')],
        [5, { x: 0, y: 0, w: 1280, h: 720 }, 1280, 10, 'Door', 'wide,wide,wide,wide,wide,wide,tall,round,round,round'], 'spot layout');
    console.log('ok spot (hero ' + h0.hero + ' from the event list, layout with heroRect, pane and shapes)');

    // a live person at Garden: hero 6 at once, a new spot stream; the old one kept until its first IDR
    srv.delay = 600;
    push({ id: 'e-p', cam: 6, label: 'Garden', type: 'person', ts: Date.now(), count: 1, thumb: false });
    await until(() => c.of('hero').slice(-1)[0].hero === 6, 'hero 6');
    await until(() => streams().length === n0s + 2, 'spot 6 opened');
    const sp6 = streams()[n0s + 1];
    assert.strictEqual(sp6.req, 'spot 6 1920x720');
    assert.ok(c.of('event').some((e) => e.id === 'e-p'), 'live event forwarded');
    await until(() => sp5.closed, 'spot 5 closed');
    assert.ok(sp5.closed >= sp6.idrAt, 'old spot kept until the new IDR');
    await until(() => c.of('layout').slice(-1)[0].hero === 6, 'layout 6');
    console.log('ok event -> hero 6 (spot 6 asked with the hero event, spot 5 closed ' + (sp5.closed - sp6.idrAt) + ' ms after its IDR)');

    // pick 2: sticks; a ring takes over and clears it
    srv.delay = 100;
    c.send({ cmd: 'pick', cam: 2 });
    await until(() => c.of('hero').slice(-1)[0].hero === 2 && streams().slice(-1)[0].req === 'spot 2 1920x720', 'picked 2');
    assert.strictEqual(c.of('hero').slice(-1)[0].why, 'picked');
    push({ id: 'e-v', cam: 7, label: 'Patio 360', type: 'vehicle', ts: Date.now(), count: 1, thumb: false });
    await sleep(300);
    assert.strictEqual(c.of('hero').slice(-1)[0].hero, 2, 'the pick sticks over an event');
    c.send({ cmd: 'stop', why: 'moving' });
    await until(() => c.states().slice(-1)[0] === 'idle', 'stopped (driving)');
    c.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    await until(() => c.states().slice(-1)[0] === 'playing' && streams().slice(-1)[0].req === 'spot 2 1920x720', 'parked again: still the pick');
    push({ id: 'e-r', cam: 0, label: 'Door', type: 'ring', ts: Date.now(), count: 1, thumb: false });
    await until(() => c.of('hero').slice(-1)[0].hero === 0 && streams().slice(-1)[0].req === 'spot 0 1920x720', 'ring -> the door camera');
    assert.strictEqual(c.of('hero').slice(-1)[0].why, 'ring');
    assert.ok(/doorbell: the camera picked gives way/.test(out), 'the ring cleared the pick');
    console.log('ok pick sticks, a ring overrides it');

    // a burst grows (same id): one row, count 3, its picture now there
    push({ id: 'e-p', cam: 6, label: 'Garden', type: 'person', ts: Date.now(), count: 3, thumb: true });
    await until(() => c.of('event').filter((e) => e.id === 'e-p').length === 2, 'update forwarded');
    c.evs = [];
    c.send({ cmd: 'status' });
    await until(() => c.of('events').length, 'status events');
    const rows = c.of('events')[0].list;
    assert.deepStrictEqual(rows.filter((e) => e.id === 'e-p').map((e) => [e.count, e.thumb]), [[3, true]], 'one row for the burst');

    // thumbs: decoded 160x90; cached; none without asking the server for a thumb:false row; bad id refused
    c.send({ cmd: 'thumb', id: 'e-jpeg' });
    await until(() => c.of('thumb').length, 'thumb');
    const th = c.of('thumb')[0], px = Buffer.from(th.rgba, 'base64');
    assert.deepStrictEqual([th.id, th.w, th.h, px.length], ['e-jpeg', 160, 90, 57600]);
    assert.ok(px.some((v, k) => k % 4 !== 3 && v > 40) && px.some((v, k) => k % 4 !== 3 && v < 200), 'a real picture');
    const asked = srv.thumbs;
    c.send({ cmd: 'thumb', id: 'e-jpeg' });
    c.send({ cmd: 'thumb', id: 'e-old' });
    c.send({ cmd: 'thumb', id: 'e-p' });
    await until(() => c.of('thumb').length === 4, 'three more thumbs');
    assert.deepStrictEqual(c.of('thumb').slice(1).map((x) => x.id + ' ' + (x.none ? 'none' : x.w)), ['e-jpeg 160', 'e-old none', 'e-p none']);
    assert.strictEqual(srv.thumbs, asked + 1, 'cached e-jpeg, e-old not asked (thumb:false), e-p asked (empty answer)');
    c.send({ cmd: 'thumb', id: 'a b' });
    await until(() => c.of('error').some((e) => e.cmd === 'thumb'), 'bad id refused');
    console.log('ok burst update, thumbs (160x90 from the JPEG, LRU, none)');

    // the user's order: a swap goes into the spot request (o=, hero in front) and into order.json
    const ORDER = path.join(tmp, 'order.json'), O1 = [0, 1, 3, 2, 4, 5, 6, 7, 8, 9, 10].join(',');
    c.send({ cmd: 'swap', a: 2, b: 3 });
    await until(() => streams().slice(-1)[0].req === 'spot 0 o=' + O1 + ' 1920x720', 'spot with the order');
    assert.strictEqual(JSON.parse(fs.readFileSync(ORDER, 'utf8')).join(','), O1, 'order.json');
    assert.strictEqual(fs.statSync(ORDER).mode & 0o777, 0o600, 'order.json 0600');
    c.send({ cmd: 'swap', a: 2, b: 99 });
    await until(() => c.of('error').some((e) => e.cmd === 'swap'), 'bad swap refused');
    const { swapped, effective } = require('../camsd.js');
    assert.deepStrictEqual(swapped(null, [0, 1, 2, 3], 2, 3, 1), [2, 0, 3, 1], 'no order yet: the server\'s (hero, then camera order)');
    assert.deepStrictEqual(swapped([0, 1, 2, 3], [0, 1, 2, 3], 2, 1, 2), [1, 2, 0, 3], 'onto the hero: it becomes the order\'s first');
    assert.deepStrictEqual(effective([3, 2, 1, 0], 0), [0, 2, 1, 3], 'the hero and the order\'s first trade places');
    assert.deepStrictEqual(swapped([5, 1, 1, 0], [0, 1, 2], 0, 2, 1), [0, 2, 1], 'unknown and repeated ids dropped, missing appended');
    console.log('ok order (swap -> o=' + O1 + ', order.json 0600)');

    // an event's clip: its line passed on, played to the server's close -> ended (last frame kept: camdec stays), no reconnect
    const nc = streams().length, k1 = c.evs.length;
    c.send({ cmd: 'view', view: 'clip', id: 'e-clip', rect: '1920x720' });
    await until(() => c.of('clip').length && c.states().slice(-1)[0] === 'playing', 'clip playing');
    assert.strictEqual(streams()[nc].req, 'clip e-clip 1920x720');
    assert.deepStrictEqual(c.of('clip')[0], { ev: 'clip', id: 'e-clip', cam: 6, label: 'Garden', type: 'person', start: 1000, dur: 700 });
    assert.strictEqual(c.of('state').slice(-1)[0].shows, 'clip');
    await until(() => c.states().slice(-1)[0] === 'ended', 'clip ended', 4000);
    assert.deepStrictEqual([c.of('state').slice(-1)[0].shows, c.of('state').slice(-1)[0].view], ['clip', 'clip'], 'ended: the clip\'s last frame shows');
    await sleep(1500);
    assert.strictEqual(streams().length, nc + 1, 'a clip that ended is not reconnected');
    assert.ok(c.evs.slice(k1).every((e) => e.ev !== 'state' || e.state !== 'error'), 'no error on a clip\'s end');
    const nk = nals().filter((l) => l[2] === 'K');
    assert.deepStrictEqual(nk.slice(0, 3).map((l) => l[1]), ['7', '8', '5'], 'camdec gets the clip from its SPS');
    assert.ok(alive(+nals().slice(-1)[0][0]), 'camdec kept after the end (its last frame stays)');
    // the same again: "Replay"
    c.send({ cmd: 'view', view: 'clip', id: 'e-clip', rect: '1920x720' });
    await until(() => streams().length === nc + 2 && c.states().slice(-1)[0] === 'playing', 'replayed');
    await until(() => c.states().slice(-1)[0] === 'ended', 'replay ended', 4000);
    // the server's error line: error, its message, no reconnect
    c.send({ cmd: 'view', view: 'clip', id: 'e-err', rect: '1920x720' });
    await until(() => c.states().slice(-1)[0] === 'error', 'clip error');
    assert.strictEqual(c.of('state').slice(-1)[0].msg, 'Recording unavailable');
    await sleep(1500);
    assert.strictEqual(streams().length, nc + 3, 'a failed clip is not retried');
    c.send({ cmd: 'view', view: 'clip', id: 'a b', rect: '1920x720' });
    await until(() => c.of('error').some((e) => e.cmd === 'view' && /clip id/.test(e.msg)), 'bad clip id refused');
    // back to the spot ("Live" goes through a cam view the same way)
    c.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    await until(() => c.states().slice(-1)[0] === 'playing' && /^spot /.test(streams().slice(-1)[0].req), 'spot after the clip');
    console.log('ok clip (line passed on, ended without reconnect, replay, error line -> its message)');

    c.s.destroy();
    await until(() => srv.evs.every((s) => s.destroyed) && streams().every((x) => x.closed), 'all closed after the last app');
    console.log('ok last client gone: event feed and spot closed');
    assert.ok(out.indexOf(TOKEN) < 0, 'token never logged (concept A part too)');

    // a restart (a car sleep) keeps the order
    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.on('exit', r));
    startDaemon();
    await until(() => fs.existsSync(CTL) && streams().length, 'restarted');
    await sleep(300);
    const e2 = app();
    await new Promise((r) => e2.s.on('connect', r));
    e2.send({ cmd: 'list' });
    await until(() => e2.of('hero').length, 'hero after restart');
    e2.send({ cmd: 'view', view: 'spot', rect: '1920x720' });
    await until(() => /^spot \d+ o=0,1,3,2,4,5,6,7,8,9,10 1920x720$/.test(streams().slice(-1)[0].req), 'order kept across a restart');
    e2.s.destroy();
    console.log('ok order kept across a restart');

    daemon.kill('SIGTERM');
    await new Promise((r) => daemon.on('exit', r));
    console.log('--- daemon log ---\n' + out.trim());
    console.log('camsd_test: all checks passed (' + process.version + ')');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.error(out); if (daemon) daemon.kill('SIGKILL'); process.exit(1); });
