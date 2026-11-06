'use strict';
// Offline smoke test of the built jap_ridewatch app (moonlight's test/smoke.js pattern): a stubbed kit ctx (HMI, display in
// the "fill" placement, speed signal), a fake ridewatchd ctl socket and a fake mgu-render socket (native dialect) for CAM.
// Covers concept A (spot layout, hero, pick, events, banner), the timeline (rows, thumbs, scroll, drag, back) and an
// event's clip on CAM (overlay, progress, ended -> Replay / Live, back to the timeline), the config sent to the service.
// Build first (./build.sh), then:
//   node test/smoke.js build/kit/dist/jap_ridewatch <tmpdir>     (Node 8: docker run --rm --network none -v $PWD:/w -w /w node:8.16.0-alpine ...)
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const Module = require('module');

const stage = path.resolve(process.argv[2]), tmp = process.argv[3];
const SRC = path.join(stage, 'source', 'javascript');
const spec = JSON.parse(fs.readFileSync(path.join(SRC, 'kit', 'app-spec.json'), 'utf8'));
const CTL = path.join(tmp, 'ctl.sock'), REN = path.join(tmp, 'render.sock'), VID = path.join(tmp, 'jap-video-ridewatch');
[CTL, REN].forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* none */ } });
fs.writeFileSync(VID, Buffer.alloc(64));
process.env.JAP_RIDEWATCH_CTL = CTL; process.env.MGU_RENDERD_SOCKET = REN; process.env.JAP_RIDEWATCH_VIDEO = VID;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, ms) { const end = Date.now() + (ms || 3000); while (!fn()) { if (Date.now() > end) throw new Error('timed out: ' + what); await sleep(10); } }
const logs = [];
const log = { info: (m) => logs.push('I ' + m), warn: (m) => logs.push('W ' + m), error: (m, e) => { logs.push('E ' + m + ' ' + (e && e.stack || e || '')); }, debug() {} };

/* ---- fake daemon ---- */
const d = { got: [], c: null };
net.createServer((c) => {
    d.c = c; let b = ''; c.setEncoding('utf8');
    c.on('data', (x) => { b += x; let i; while ((i = b.indexOf('\n')) >= 0) { d.got.push(JSON.parse(b.slice(0, i))); b = b.slice(i + 1); } });
    c.on('error', () => {});
}).listen(CTL);
d.send = (o) => d.c.write(JSON.stringify(o) + '\n');
d.cmds = (cmd) => d.got.filter((m) => m.cmd === cmd);
d.last = () => d.got.filter((m) => m.cmd === 'view' || m.cmd === 'stop').slice(-1)[0];

/* ---- fake renderer (CAM's own connection) ---- */
const r = { msgs: [], c: null, hello: null };
net.createServer((c) => {
    r.c = c; let b = Buffer.alloc(0);
    c.on('data', (x) => {
        b = Buffer.concat([b, x]);
        while (b.length >= 8) {
            const t = b.readUInt32LE(0), n = b.readUInt32LE(4);
            if (b.length < 8 + n) break;
            const p = b.slice(8, 8 + n); b = b.slice(8 + n);
            if (t === 1) {
                r.hello = p.toString();
                const xr = Buffer.alloc(52); xr.writeUInt32LE(1, 0); xr.writeUInt32LE(1, 4); xr.writeUInt32LE(1 | 2 | 8 | 16, 8);
                const rd = Buffer.alloc(12); rd.writeUInt32LE(1920, 4); rd.writeUInt32LE(720, 8);
                [[0x4d520101, xr], [101, rd]].forEach((m) => { const h = Buffer.alloc(8); h.writeUInt32LE(m[0], 0); h.writeUInt32LE(m[1].length, 4); c.write(Buffer.concat([h, m[1]])); });
            } else r.msgs.push({ t, p, at: Date.now() });
        }
    });
    c.on('error', () => {});
}).listen(REN);
r.send = (t, p) => { const h = Buffer.alloc(8); h.writeUInt32LE(t, 0); h.writeUInt32LE(p.length, 4); r.c.write(Buffer.concat([h, p])); };
r.types = (t) => r.msgs.filter((m) => m.t === t);
const shownLayer = () => { const s = r.types(3); return s.length ? s[s.length - 1].p.readUInt32LE(0) : 0; };
const ccu = (seq, knob, press, tilt) => { const p = Buffer.alloc(8); p[0] = seq; p.writeUInt16BE(knob, 1); p[3] = press; p[4] = tilt; r.send(0x4d520103, p); };
// the VIDEO op (19) of a FRAME payload / of a recording: [x, y, w, h] where the stream's frame is drawn
const videoAt = (u, f, n) => { for (let i = 0; i + 6 < n; i++) if (u[i] === 19 && u[i + 6] === 1) return [f[i + 1], f[i + 2], f[i + 3], f[i + 4]].map(Math.round); return null; };
const frameVideo = (p) => { const b = Buffer.from(p); return videoAt(new Uint32Array(b.buffer, b.byteOffset, b.length >> 2), new Float32Array(b.buffer, b.byteOffset, b.length >> 2), b.length >> 2); };
const touch = (ph, x, y) => { const p = Buffer.alloc(12); p.writeUInt32LE(ph, 0); p.writeFloatLE(x, 4); p.writeFloatLE(y, 8); r.send(105, p); };

/* ---- stub kit ---- */
const { Recorder } = require(path.join(SRC, 'kit', 'record'));
const rtext = Recorder.prototype.text;
Recorder.prototype.text = function (s) { (this.said || (this.said = [])).push(String(s)); return rtext.apply(this, arguments); };
let camCv = null;                 // CAM's recordings: the ones the app makes itself (not the kit's canvas)
const rvideo = Recorder.prototype.video;
Recorder.prototype.video = function () { if (!this.kitCanvas) camCv = this; return rvideo.apply(this, arguments); };
const PL = { x: 0, y: 0, w: 1920, h: 720, full: true, scale: 1.2, ox: 0, oy: 0, extra: 80 };   // the kit's "fill" placement
const kv = [];                    // the kit renderer's video calls
const display = { place: PL, gpu: { native: true, video: (id, p) => kv.push(['video', id, p]), dropVideo: (id) => kv.push(['drop', id]) } };
const visH = [], loops = {};
let failOpen = 0, stack = [], shot = { said: [], targets: [], video: false };
const top = () => stack[stack.length - 1];
const ui = {
    image: (n, cv) => { assert.strictEqual(n, 'VIEW_GFX'); shot = { said: cv.said || [], targets: cv.targets.slice(), video: !!cv.hasVideo, images: Array.from(cv.images) }; return Promise.resolve(); },
    open: (n) => { if (failOpen > 0) { failOpen--; return Promise.resolve(); }   // the HMI refused (INVALID_COMPONENTID, 05/11)
        const old = top(); stack.push(n); if (old !== n) { if (old) visH.forEach((f) => f(old, false)); visH.forEach((f) => f(n, true)); } return Promise.resolve(); },
    back: () => { const old = stack.pop(); visH.forEach((f) => f(old, false)); if (top()) visH.forEach((f) => f(top(), true)); },
    isVisible: (n) => top() === n, hasFocus: () => true, onVisible: (fn) => visH.push(fn), onFocus() {}, text() {}, onClick() {},
};
const draw = () => { if (loops.VIEW) loops.VIEW(); return shot; };
const says = (re) => draw().said.some((s) => re.test(s));
const keys = () => draw().targets.map((x) => x.key);
const picked = (cam, what) => until(() => d.cmds('pick').length && d.cmds('pick').slice(-1)[0].cam === cam, what || 'pick ' + cam);
const tgt = (key) => draw().targets.find((q) => q.key === key);
const tap = (key) => { const x = draw().targets.find((q) => q.key === key); assert.ok(x, 'target ' + key + ' in ' + keys().join(' ')); x.run(); };
const values = {}; spec.settings.forEach((s) => { values[s.key] = s.default; });
assert.strictEqual(values.parkedOnly, true, 'shipped default: parked only');
const listeners = [];
const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; listeners.forEach((f) => f(k, v)); }, onChange: (f) => listeners.push(f) };
const sig = {};
const signals = { watch: (iface, inst, h) => { sig[iface] = h; return Promise.resolve({}); } };
// the car re-reads the speed every 2 s; the kit counts a reading older than 5 s as moving
let kmhNow = null;
const speedNow = () => sig['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: kmhNow / 0.015625 });
const speed = (kmh) => { kmhNow = kmh; speedNow(); };
setInterval(() => { if (kmhNow !== null) speedNow(); }, 1000).unref();
const hooks = {};
const ctx = {
    ui, settings, log, spec, signals, dataDir: tmp, display,
    canvas: (w, h) => { const c = new Recorder(w, h, { textScale: PL.scale }); c.kitCanvas = true; c.own = true; c.place = PL; const v = c.video; c.video = function () { c.hasVideo = true; return v.apply(c, arguments); }; return c; },
    loop: (n, fps, fn) => { loops[n] = fn; },
    onPageFocus: (fn) => { hooks.focus = fn; }, onLayout() {}, focus: (k) => { hooks.focused = k; },
    onTouch: (fn) => { hooks.touch = fn; }, onBack: (fn) => { hooks.back = fn; },
};
const realLoad = Module._load;
Module._load = function (req) {
    if (req === './kit/mgu') return { run: (impl) => impl.start(ctx), log };
    return realLoad.apply(this, arguments);
};

(async () => {
    require(path.join(SRC, 'app.js'));
    stack = ['VIEW']; visH.forEach((f) => f('VIEW', true));
    assert.strictEqual(spec.screens.filter((s) => s.kind === 'canvas')[0].name, 'VIEW', 'VIEW is the first canvas screen (the kit draws it)');
    await until(() => d.cmds('status').length && d.cmds('list').length, 'status + list on connect');
    await until(() => r.hello && r.hello.indexOf('jap_ridewatch\0proto=mgu-render/1') === 0, 'native HELLO');
    // the settings go to the service first: defaults (no address yet), then again on a change
    assert.deepStrictEqual(d.cmds('config')[0], { cmd: 'config', host: [0, 0, 0, 0], port: 18640, socks: 1065, socksFallback: 0, lat: 0, lon: 0 }, 'config on connect');
    settings.set('server1', 192); settings.set('server2', 0); settings.set('server3', 2); settings.set('server4', 10); settings.set('lat', 51);
    await until(() => d.cmds('config').length >= 5, 'config on every change');
    assert.deepStrictEqual(d.cmds('config').slice(-1)[0], { cmd: 'config', host: [192, 0, 2, 10], port: 18640, socks: 1065, socksFallback: 0, lat: 51, lon: 0 });
    const LABELS = ['Door', 'Garage', 'Yard', 'Drive', 'Street', 'Side', 'Garden', 'Patio 360', 'Shed', 'Porch', 'Attic'];
    d.send({ ev: 'state', state: 'idle', view: null, msg: null });
    d.send({ ev: 'list', cams: LABELS.map((label, i) => ({ i, name: 'Cam ' + i, label })) });

    // parked only, strict: no speed read yet = moving -> no stream, the notice
    await sleep(400);
    assert.strictEqual(d.cmds('view').length, 0, 'no view before a speed');
    assert.ok(says(/^Available only while parked$/), 'parked-only notice: ' + draw().said.join(' | '));
    speed(0);
    await until(() => d.cmds('view').length === 1, 'view once parked');
    assert.deepStrictEqual(d.cmds('view')[0], { cmd: 'view', view: 'spot', rect: '1920x720' }, 'the spot at the placement size');
    d.send({ ev: 'state', state: 'connecting', view: 'spot', msg: null });
    await until(() => says(/^Connecting…$/), 'connecting');
    assert.deepStrictEqual(keys(), [], 'no targets before the picture');

    // the spot layout is data (the server's rects): hero 3 (day default), the pane's wide / tall / round tiles
    const now = Date.now();
    const evs = [
        { id: 'y1', cam: 6, label: 'Garden', type: 'animal', ts: new Date(new Date(now).setHours(0, 0, 0, 0)).getTime() - 6 * 3600000, count: 1, thumb: false },
        { id: 'm1', cam: 2, label: 'Yard', type: 'motion', ts: now - 400000, count: 1, thumb: false },
    ];
    for (let k = 0; k < 9; k++) evs.push({ id: 't' + k, cam: k % 11, label: LABELS[k % 11], type: ['person', 'vehicle', 'package'][k % 3], ts: Math.max(new Date(now).setHours(0, 0, 0, 0) + 1000 * k, now - 3600000 * (9 - k)), count: 1 + (k % 2), thumb: k === 8 });
    evs.sort((a, b) => a.ts - b.ts);
    d.send({ ev: 'events', list: evs });
    d.send({ ev: 'hero', hero: 3, why: 'default', event: null, night: false, home: true });
    const tile = (i, x, y, w, h, shape) => ({ i, name: 'x', label: LABELS[i], x, y, w, h, shape });
    const L = { ev: 'layout', w: 1920, h: 720, hero: 3, heroRect: { x: 0, y: 0, w: 1280, h: 720 }, pane: { x: 1280, y: 0, w: 640, h: 720 },
        tiles: [tile(0, 1280, 0, 320, 180, 'wide'), tile(1, 1600, 0, 320, 180, 'wide'), tile(8, 1280, 540, 136, 180, 'tall'), tile(10, 1424, 550, 160, 160, 'round')] };
    d.send(L);
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });
    await until(() => keys().indexOf('cam:10') >= 0, 'spot targets');
    assert.deepStrictEqual(keys(), ['hero', 'cam:0', 'cam:1', 'cam:8', 'cam:10', 'tab:live', 'tab:past'], 'the knob\'s order: hero, pane tiles, tabs');
    const r1 = tgt('cam:1');
    assert.deepStrictEqual([r1.x, r1.y, r1.w, r1.h].map(Math.round), [1333, 0, 267, 150], 'stream px -> page px (1.2)');
    assert.ok(says(/^Drive$/) && says(/^Day · car at home$/) && says(/^\d\d:\d\d$/), 'hero name, context, clock');
    assert.ok(says(/^Door$/) && says(/^Garage$/) && says(/^Shed$/) && says(/^Attic$/), 'tile labels');
    assert.ok(!says(/Connecting/), 'no state line while playing');
    await until(() => kv.some((c) => c[0] === 'video' && c[2] === VID), 'kit renderer told the video file');
    assert.ok(draw().video, 'VIEW frame draws the video (op 19)');

    // a tap on a pane tile: that camera becomes the hero (the daemon's pick), no CAM
    tap('cam:1');
    await picked(1);
    assert.strictEqual(top(), 'VIEW');
    // the daemon's new hero: its name at once, the old picture (layout) until the new spot's first frame
    d.send({ ev: 'hero', hero: 1, why: 'picked', event: null, night: false, home: true });
    await until(() => says(/^Garage$/) && tgt('hero'), 'new hero name');
    // a ring at the door: the ring, "Ring · Door", a banner (a live event)
    d.send({ ev: 'event', id: 'r1', cam: 0, label: 'Door', type: 'ring', ts: Date.now(), count: 1, thumb: false });
    d.send({ ev: 'hero', hero: 0, why: 'ring', event: { id: 'r1', cam: 0, type: 'ring', ts: Date.now() }, night: true, home: false });
    await until(() => says(/^Ring · Door$/) && says(/^Night · car away$/), 'ring title');
    assert.ok(says(/^just now$/), 'ring sub line');

    // a tap on the hero: CAM with it
    tap('hero');
    assert.strictEqual(top(), 'CAM');
    await until(() => d.last().view === 0, 'view 0');
    assert.deepStrictEqual(d.last(), { cmd: 'view', view: 0, rect: '1920x720' });
    await until(() => shownLayer() === 1 && r.types(13).length, 'CAM layer shown, video named');
    assert.ok(r.types(13)[0].p.slice(4).toString().indexOf(VID) === 0, 'VIDEO names the frame file');
    d.send({ ev: 'state', state: 'connecting', view: 0, msg: null });
    await until(() => camCv && (camCv.said || []).indexOf('Connecting…') >= 0, 'CAM connecting');
    d.send({ ev: 'state', state: 'playing', view: 0, msg: null });
    await until(() => camCv && (camCv.said || []).indexOf('Connecting…') < 0, 'CAM playing');
    assert.ok((camCv.said || []).indexOf('Door') >= 0, 'camera name on CAM');
    const f0 = r.types(7).length;
    await sleep(2100);
    const nf = r.types(7).length - f0;
    assert.ok(nf >= 3, 'keepalive frames on CAM: ' + nf + ' in 2.1 s');
    const fr = r.types(7)[r.types(7).length - 1].p;
    assert.deepStrictEqual(frameVideo(fr), [-480, -180, 2880, 1080], 'CAM fills the screen: the 16:9 picture at 1.5x, centred');
    // a finger drags: the picture pans (no back); the chip: the whole picture; the controller: fill again, pan up
    touch(1, 900, 300); touch(2, 900, 350); touch(2, 900, 400);
    await until(() => (frameVideo(r.types(7).slice(-1)[0].p) || [])[1] === -80, 'panned 100 px down');
    touch(3, 900, 400);
    await sleep(100);
    assert.strictEqual(top(), 'CAM', 'a drag is no tap');
    touch(1, 1700, 650); touch(3, 1700, 650);
    await until(() => String(frameVideo(r.types(7).slice(-1)[0].p)) === '0,0,1920,720', 'chip: the whole picture');
    assert.ok((camCv.said || []).indexOf('Fill the screen') >= 0, 'the chip says what it does next');
    ccu(1, 100, 0, 0); ccu(2, 100, 0, 4);
    await until(() => String(frameVideo(r.types(7).slice(-1)[0].p)) === '-480,-180,2880,1080', 'pushed right: fill again, centred');
    ccu(3, 100, 0, 0); ccu(4, 100, 0, 1);
    await until(() => String(frameVideo(r.types(7).slice(-1)[0].p)) === '-480,0,2880,1080', 'pushed up: the top (clamped)');
    assert.strictEqual(top(), 'CAM');

    // the controller: a turn = the next camera, a press = back to the spot
    ccu(1, 100, 0, 0); ccu(2, 101, 0, 0);
    await until(() => d.last().view === 1, 'turn: next camera (0 -> 1)');
    ccu(3, 101, 1, 0); ccu(4, 101, 0, 0);
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'press: spot');
    await until(() => shownLayer() === 0, 'CAM layer hidden');
    assert.deepStrictEqual(keys(), [], 'no targets until the daemon plays the spot again (the camera picture is still up)');
    const spot = () => { d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null }); return until(() => keys().indexOf('hero') >= 0, 'spot back'); };
    await spot();
    // the HMI's BACK on CAM, and a tap on CAM: back on VIEW
    tap('hero');
    await until(() => d.last().view === 0, 'view 0 again');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: spot');
    await spot();
    tap('hero');
    await until(() => d.last().view === 0 && shownLayer() === 1, 'view 0 shown');
    touch(1, 900, 300); touch(3, 900, 300);
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'tap on CAM: spot');
    await spot();
    // CAM of the spot's hero: the spot stream already playing, framed on its hero (no new view: at once)
    d.send(Object.assign({}, L, { hero: 0 }));
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await sleep(150);                                     // (the layout and the state in)
    const nv = d.cmds('view').length;
    tap('hero');
    await until(() => shownLayer() === 1 && String(frameVideo(r.types(7).slice(-1)[0].p)) === '0,-180,2880,1080', 'CAM on the spot\'s hero');
    await sleep(300);
    assert.strictEqual(d.cmds('view').length, nv, 'no new stream for the hero\'s CAM: ' + JSON.stringify(d.cmds('view').slice(nv - 1)));
    assert.ok((camCv.said || []).indexOf('Connecting…') < 0, 'nothing to wait for');
    touch(1, 900, 300); touch(3, 900, 300);
    await until(() => top() === 'VIEW' && shownLayer() === 0, 'back');
    await sleep(300);
    assert.strictEqual(d.cmds('view').length, nv, 'and back without a new stream');
    d.send(L);
    console.log('ok spot: layout, hero, pick, ring, CAM (fill, pan, whole, controller; the hero\'s at once) and back');

    // drag and drop on "En direct": held 0.45 s it lifts, dropped on a tile of its shape or on the hero: a swap
    await until(() => keys().indexOf('cam:10') >= 0, 'layout back');
    const picks = d.cmds('pick').length;
    assert.strictEqual(hooks.touch(1, 1440, 90), false, 'down on a tile: still the kit\'s (a tap may come)');
    assert.strictEqual(hooks.touch(2, 1445, 92), false, 'a small move: not lifted');
    await sleep(550);
    assert.strictEqual(hooks.touch(2, 1700, 90), true, 'held: lifted, ours');
    draw();
    assert.strictEqual(hooks.touch(3, 1760, 90), true, 'dropped');
    await until(() => d.cmds('swap').length === 1, 'swap sent');
    assert.deepStrictEqual(d.cmds('swap')[0], { cmd: 'swap', a: 0, b: 1 });
    hooks.touch(1, 1348, 630); assert.strictEqual(hooks.touch(2, 600, 400), true, 'dragged off at once: lifted');
    hooks.touch(3, 600, 400);
    await until(() => d.cmds('swap').length === 2, 'second swap');
    assert.deepStrictEqual(d.cmds('swap')[1], { cmd: 'swap', a: 8, b: 3 }, 'the door onto the hero');
    hooks.touch(1, 1500, 630); hooks.touch(2, 1440, 90); hooks.touch(3, 1440, 90);
    await sleep(100);
    assert.strictEqual(d.cmds('swap').length, 2, 'a round 360 on a wide tile: no swap');
    hooks.touch(1, 1440, 90);
    assert.strictEqual(hooks.touch(3, 1440, 90), false, 'a quick tap: the kit\'s (its pick)');
    assert.strictEqual(d.cmds('pick').length, picks, 'no pick from a drag');
    d.send(L);
    console.log('ok drag and drop (swap within a shape, onto the hero)');

    // "What happened": rows newest first (never motion), day headers, a thumb asked for a drawn row with one
    const views = d.cmds('view').length;
    tap('tab:past');
    await until(() => keys().some((k) => k.indexOf('ev:') === 0), 'timeline rows');
    const evKeys = () => keys().filter((k) => k.indexOf('ev:') === 0);
    assert.deepStrictEqual(evKeys(), ['ev:r1'].concat(evs.filter((e) => e.type !== 'motion').reverse().map((e) => 'ev:' + e.id)), 'newest first, no motion');
    assert.ok(keys().indexOf('cam:0') < 0, 'the pane tiles are under the panel');
    assert.ok(says(/^Today$/) && says(/^Ring$/) && says(/^Package · ×2$/) && says(/^just now$/), 'header, types, counts, times: ' + draw().said.filter((x) => /yesterday|Today|×/.test(x)).join(' | '));
    assert.strictEqual(d.cmds('view').length, views, 'the hero stays live: no new view');
    await until(() => d.cmds('thumb').length, 'thumb asked');
    assert.deepStrictEqual(d.cmds('thumb').map((m) => m.id), ['t8'], 'only rows with a picture');
    const rgba = Buffer.alloc(160 * 90 * 4, 200);
    d.send({ ev: 'thumb', id: 't8', w: 160, h: 90, rgba: rgba.toString('base64') });
    await until(() => draw().images.length === 1, 'thumb drawn');
    // a row without a picture yet: asked once its update says it has one
    d.send({ ev: 'event', id: 'r1', cam: 0, label: 'Door', type: 'ring', ts: Date.now(), count: 2, thumb: true });
    await until(() => draw() && d.cmds('thumb').some((m) => m.id === 'r1'), 'r1 thumb asked after its update');
    d.send({ ev: 'thumb', id: 'r1', none: true });
    assert.deepStrictEqual(evKeys().slice(0, 1), ['ev:r1'], 'the update kept one row');

    // the scroll bar, a drag, a flick's inertia, the controller's row brought into view
    const lastKey = evKeys().slice(-1)[0], y0 = tgt(lastKey).y, picks0 = d.cmds('pick').length;
    assert.ok(y0 * 1.2 > 720, 'the last row starts below the screen');
    hooks.touch(1, 1500, 600);
    hooks.touch(2, 1500, 560); hooks.touch(2, 1500, 500);
    const y1 = tgt(lastKey).y;
    assert.ok(Math.abs((y0 - y1) * 1.2 - 100) < 2, 'the list follows the finger: ' + (y0 - y1) * 1.2);
    await sleep(20);
    hooks.touch(2, 1500, 440);
    const y2 = tgt(lastKey).y;            // where the finger left it (not at the list's end: 160 of ~670 px)
    hooks.touch(3, 1500, 440);
    await sleep(200);
    const y3 = tgt(lastKey).y;
    assert.ok(y3 < y2, 'inertia after the release: ' + y2 + ' -> ' + y3);
    assert.strictEqual(d.cmds('pick').length, picks0, 'a drag is no tap');
    hooks.focus(evKeys()[0]);
    await until(() => tgt(evKeys()[0]).y * 1.2 >= 0, 'the first row back into view');
    hooks.focus(lastKey);
    await until(() => { const t = tgt(lastKey); return (t.y + t.h) * 1.2 <= 720; }, 'the last row into view');
    assert.ok(says(/^Yesterday$/) && says(/^yesterday \d\d:\d\d$/), 'yesterday\'s header and time');
    // a tap on a row: that event's clip on CAM (no pick yet)
    const lr = tgt(lastKey), tapY = (lr.y + lr.h / 2) * 1.2, old = evs.filter((e) => e.type !== 'motion')[0];
    const picks1 = d.cmds('pick').length;
    hooks.touch(1, 1500, tapY); hooks.touch(3, 1500, tapY);
    await until(() => top() === 'CAM' && d.last().view === 'clip', 'tap on the oldest row: its clip');
    assert.deepStrictEqual(d.last(), { cmd: 'view', view: 'clip', id: old.id, rect: '1920x720' });
    assert.strictEqual(d.cmds('pick').length, picks1, 'a clip is no pick');
    await until(() => shownLayer() === 1 && camCv && (camCv.said || []).indexOf('Connecting…') >= 0, 'CAM layer, connecting');
    const T0 = { person: 'Person', vehicle: 'Vehicle', package: 'Package', animal: 'Animal' }[old.type] + ' · ' + LABELS[old.cam] + ' · ';
    d.send({ ev: 'state', state: 'connecting', view: 'clip', msg: null, shows: 'spot' });
    d.send({ ev: 'clip', id: old.id, cam: old.cam, label: LABELS[old.cam], type: old.type, start: old.ts - 5000, dur: 1500 });
    d.send({ ev: 'state', state: 'playing', view: 'clip', msg: null, shows: 'clip' });
    await until(() => (camCv.said || []).some((x) => x.indexOf(T0) === 0) && (camCv.said || []).indexOf('Connecting…') < 0, 'clip overlay: ' + T0);
    assert.deepStrictEqual(frameVideo(r.types(7).slice(-1)[0].p), [-480, -180, 2880, 1080], 'the clip fills the screen as a camera');
    assert.ok((camCv.said || []).indexOf('Whole picture') < 0 && (camCv.said || []).indexOf('Replay') < 0, 'no chip, no buttons while it plays');
    const fc = r.types(7).length;
    await sleep(500);
    assert.ok(r.types(7).length - fc >= 5, 'the progress bar redraws: ' + (r.types(7).length - fc) + ' frames in 0.5 s');
    d.send({ ev: 'state', state: 'ended', view: 'clip', msg: null, shows: 'clip' });
    await until(() => ['Replay', 'Live'].every((x) => (camCv.said || []).indexOf(x) >= 0), 'ended: Replay, Live');
    assert.strictEqual(top(), 'CAM', 'the last frame stays');
    const nv1 = d.cmds('view').length;
    touch(1, 800, 650); touch(3, 800, 650);
    await until(() => d.cmds('view').length === nv1 + 1, 'Replay: the clip again');
    assert.deepStrictEqual(d.last(), { cmd: 'view', view: 'clip', id: old.id, rect: '1920x720' });
    d.send({ ev: 'state', state: 'connecting', view: 'clip', msg: null, shows: null });
    d.send({ ev: 'state', state: 'ended', view: 'clip', msg: null, shows: 'clip' });
    await until(() => (camCv.said || []).indexOf('Replay') >= 0, 'ended again');
    touch(1, 1100, 650); touch(3, 1100, 650);
    await until(() => d.last().view === old.cam, 'Live: that camera live');
    await picked(old.cam, 'Live picks it');
    assert.strictEqual(top(), 'CAM');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await until(() => keys().indexOf('ev:t8') >= 0, 'the timeline again');
    // a press with the controller (the kit runs the target): the clip; an error said; BACK to the timeline
    tgt('ev:t8').run();
    await until(() => top() === 'CAM' && d.last().view === 'clip' && d.last().id === 't8', 'press on a row: its clip');
    d.send({ ev: 'state', state: 'error', view: 'clip', msg: 'Video unavailable' });
    await until(() => (camCv.said || []).indexOf('Video unavailable') >= 0, 'clip error shown');
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    await until(() => keys().indexOf('ev:t8') >= 0, 'still on the timeline');
    // the spot's picture away (back from a clip, a stall): the timeline stays and a finger's tap still plays;
    // the HMI refusing to open CAM once: asked again
    d.send({ ev: 'state', state: 'connecting', view: 'spot', msg: null, shows: 'clip' });
    await until(() => keys().indexOf('ev:t8') >= 0, 'the timeline without the spot\'s picture');
    const t8 = tgt('ev:t8'), y8 = (t8.y + t8.h / 2) * 1.2;
    failOpen = 1;
    hooks.touch(1, 1500, y8); hooks.touch(3, 1500, y8);
    await until(() => top() === 'CAM' && d.last().view === 'clip' && d.last().id === 't8', 'a finger on a row with no picture, CAM refused once: its clip', 4000);
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    failOpen = 2;                                    // refused twice: given up, said, the next tap works
    hooks.touch(1, 1500, y8); hooks.touch(3, 1500, y8);
    await until(() => says(/did not open/), 'a clip that did not open is said', 5000);
    assert.strictEqual(top(), 'VIEW');
    hooks.touch(1, 1500, y8); hooks.touch(3, 1500, y8);
    await until(() => top() === 'CAM' && d.last().view === 'clip', 'the next tap plays', 4000);
    ui.back();
    await until(() => top() === 'VIEW' && d.last().view === 'spot', 'BACK: the spot');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null, shows: 'spot' });
    // pushed left: back to "En direct"
    assert.strictEqual(hooks.back(false), true, 'onBack took it');
    await until(() => keys().indexOf('cam:0') >= 0, 'live tab again');
    assert.strictEqual(hooks.back(false), false, 'on the live tab the kit\'s back');
    hooks.touch(1, 1500, 300);
    assert.strictEqual(hooks.touch(3, 1500, 300), false, 'a tap on the pane on the live tab is the kit\'s (its targets)');
    console.log('ok timeline: rows, headers, thumbs, drag + inertia, controller, clip (overlay, Replay, Live, error, no picture, CAM refused), back');

    // the daemon's error, shown as it says
    d.send({ ev: 'state', state: 'error', view: 'spot', msg: 'connection lost - retry in 2 s' });
    await until(() => says(/^connection lost - retry in 2 s$/), 'error message');
    d.send({ ev: 'state', state: 'playing', view: 'spot', msg: null });

    // driving: stop + notice; parked again: the spot again
    speed(10);
    await until(() => d.last().cmd === 'stop', 'stop above 3 km/h');
    assert.strictEqual(d.last().why, 'moving', 'driving off: the daemon keeps the pick');
    assert.ok(says(/^Available only while parked$/), 'parked-only notice');
    assert.deepStrictEqual(keys(), [], 'no targets while driving');
    d.send({ ev: 'state', state: 'idle', view: null, msg: null });
    speed(2);
    await until(() => d.last().cmd === 'view' && d.last().view === 'spot', 'view again when parked');
    // the setting off: no gate
    settings.set('parkedOnly', false);
    speed(50);
    await sleep(400);
    assert.strictEqual(d.last().cmd, 'view', 'parkedOnly off: plays while driving');
    settings.set('parkedOnly', true); speed(0);

    // hidden (Home, another app): stop
    const s0 = d.cmds('stop').length;
    const was = top(); stack = []; visH.forEach((f) => f(was, false));   // (the stub's stack holds every open; the HMI's does not)
    await until(() => d.cmds('stop').length === s0 + 1, 'stop when hidden');
    await sleep(600);
    assert.strictEqual(d.cmds('stop').length, s0 + 1, 'stop once');
    assert.strictEqual(d.cmds('stop').slice(-1)[0].why, 'hidden', 'left the app: the pick goes');

    const errs = logs.filter((l) => l[0] === 'E');
    assert.deepStrictEqual(errs, [], 'no errors logged');
    console.log('smoke: all checks passed (' + process.version + ')');
    process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.stack || e); console.error(logs.slice(-30).join('\n')); process.exit(1); });
