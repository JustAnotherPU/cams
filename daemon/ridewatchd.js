'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * ridewatchd.js - the jap-ridewatch service on the car (Node 22, jap-node22). Serves ctl.sock to the RideWatch app (Node 8),
 * fetches the H.264 stream from the RideWatch server through a local SOCKS5 proxy (the car has no TUN: a tunnel such
 * as Tailscale or WireGuard offers one on 127.0.0.1) and feeds it to camdec's stdin (camdec writes the MGVF frames
 * the app's layer shows). While an app is connected it also holds the server's event feed and picks the spot
 * view's hero camera.
 *
 * Environment (defaults are the car's):
 *   JAP_RIDEWATCH_CONF   /var/opt/jap-ridewatch/state/server.json (0600), written here: {"host","port","socks":"127.0.0.1:1065",
 *                   optional "socksFallback" (a second SOCKS proxy, tried when "socks" fails, then used first for a
 *                   minute), "lat", "lon" (night = sunset..sunrise; none: always day), "token" (the car's code, made
 *                   here at the first start), optional "homeSsid" (the home Wi-Fi, by hand: "car at home")}.
 *                   The app's settings set host, port, socks, socksFallback, lat and lon ({"cmd":"config"}).
 *   JAP_RIDEWATCH_CTL    /run/jap-ridewatch/ctl.sock               MGU_UPLINK /run/mgu-uplink/status.json (mgu-uplink's Wi-Fi state)
 *   JAP_CAMDEC      /var/opt/jap-ridewatch/current/camdec      JAP_RIDEWATCH_VIDEO /dev/shm/mgu-video-ridewatch
 *
 * App -> daemon: {"cmd":"list"} {"cmd":"view","view":"spot"|"mosaic"|i,"rect":"WxH"} {"cmd":"pick","cam":i}
 *   {"cmd":"config","host":[a,b,c,d],"port","socks","socksFallback","lat","lon"} (0.0.0.0 keeps the address in
 *       server.json; socksFallback 0: none; lat 0 and lon 0: no night rule)
 *   {"cmd":"view","view":"clip","id","rect":"WxH"} (an event's recording, `<token> clip <id> WxH`: played once,
 *       then state "ended" with its last frame kept; never reconnected. The same command again replays it)
 *   {"cmd":"thumb","id"} (an event's picture: fetched `<token> thumb <id>`, JPEG decoded here, kept in an LRU of 60)
 *   {"cmd":"stop","why":"hidden"|"moving"} (moving keeps the pick) {"cmd":"status"}
 *   {"cmd":"swap","a":i,"b":j} (the user dropped camera a on b, b may be the hero: then a becomes the picked hero):
 *       the pane's order, kept in order.json beside server.json and sent with every spot (`o=`)
 * Daemon -> app: {"ev":"list","cams":[{i,name,label,shape,w,h,roles}]} {"ev":"state","state":"idle|connecting|playing|ended|error","view":..,"msg":..,"shows":..}
 *   {"ev":"clip",id,cam,label,type,start,dur}  the server's line for a clip (ms), sent when its picture starts
 *   {"ev":"layout","w","h","hero","heroRect","tiles":[{i,name,label,x,y,w,h,shape}]}  the server's line for the
 *       picture now shown (stream px), sent when the stream switches to it
 *   {"ev":"hero","hero":i,"why":"ring|person|event|picked|default","event":{..}|null,"night":bool,"home":bool|null}
 *       sent as soon as the choice changes (the new stream follows ~1 s later)
 *   {"ev":"events","list":[{id,cam,label,type,ts,first,count,thumb}]} (newest last; on connect and status)
 *   {"ev":"event",id,cam,label,type,ts,first,count,thumb} (live: an id already listed updates that row, the server's burst)
 *   {"ev":"thumb","id","w":160,"h":90,"rgba":base64} | {"ev":"thumb","id","none":true}  to the asker only
 *   {"ev":"stats",...camdec's stats,"kbps"}  {"ev":"error","cmd":..,"msg"}
 *
 * Hero (chooseHero), from the camera roles the server lists (set on the server, server/configure.py; all optional):
 * a doorbell ring, or a person at the "door" camera, in the last 2 min -> the door camera (a ring without one: the
 * ringing camera); else the camera the user picked (until the app stops the view; a ring clears it); else the latest
 * person / vehicle / animal / package in the last 10 min (not the "garage" camera while the car is home); else the
 * "night" camera at night, the "day" camera otherwise, else the first camera.
 *
 * A view: SOCKS5 connect, `<token> spot <hero> WxH` / `mosaic2 WxH` (the server's layout line first, then Annex-B)
 * or `<token> cam i WxH` or `<token> clip <id> WxH` (its {"ev":"clip"} line first, or {"ev":"clip","error"}).
 * Switching: camdec keeps running and its stdin moves to the new connection once that one's first IDR is in (camdec
 * resets on the new SPS and keeps its last frame meanwhile, so the old picture stays; a restarted camdec would re-init
 * the MSDK and could recreate the MGVF file, a black flash). While the new one connects, the old stream is cut at NAL
 * boundaries so camdec never gets a half NAL before the new SPS.
 * Drops reconnect after 1, 2, 4, 8, 10 s (not a clip: its end is "ended", its failure "error"); the last app
 * connection gone stops everything at once (camdec killed after 1 s if stdin EOF did not end it). The token is never
 * logged (the app shows it while the server refuses the car, so that it can be added there). Never exits on an error.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const socks = require('./socks');
const decodeJpeg = require('./vendor/jpeg-js/decoder.js');

const CONF = process.env.JAP_RIDEWATCH_CONF || '/var/opt/jap-ridewatch/state/server.json';
const ORDER = require('path').join(require('path').dirname(CONF), 'order.json');   // the state dir: nobody's, 0700
const CTL = process.env.JAP_RIDEWATCH_CTL || '/run/jap-ridewatch/ctl.sock';
const BIN = process.env.JAP_CAMDEC || '/var/opt/jap-ridewatch/current/camdec';
const VIDEO = process.env.JAP_RIDEWATCH_VIDEO || '/dev/shm/mgu-video-ridewatch';
const UPLINK = process.env.MGU_UPLINK || '/run/mgu-uplink/status.json';
const BACKOFF = [1000, 2000, 4000, 8000, 10000];
const FIRST_MS = 10000;          // connect to first IDR (measured 0.2 s cam, 0.5 s mosaic, 0.8-1.4 s spot)
const CLIP_FIRST_MS = 40000;     // a clip: Protect login + export (0.5 s for 8 s measured, the server waits 30 s at most)
// the server's clip error codes (serve.py clip()), as the app shows them
const CLIP_ERR = { event: 'Event not found', config: 'Protect is not set up on the server', unreachable: 'Protect unreachable',
    login: 'Protect refused the login', cameras: 'Camera not found in Protect', camera: 'Camera not found in Protect',
    export: 'Recording unavailable' };
const SILENT_MS = 5000;          // a live stream quiet this long is a drop (a half-open tunnel)
const EVENTS_SILENT_MS = 40000;  // the event feed pings every 15 s
const MAX_PENDING = 4 << 20;     // bytes held before the first IDR
const TYPES = ['person', 'vehicle', 'animal', 'package', 'motion', 'ring'];
const SHAPES = ['wide', 'tall', 'round'];
const ROLES = ['door', 'garage', 'day', 'night'];
const THUMB_W = 160, THUMB_H = 90, THUMB_LRU = 60, THUMB_MAX = 1 << 20, THUMB_JOBS = 2;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;   // an event id goes into a request line

const log = (...a) => console.log(new Date().toISOString(), ...a);
const clients = new Set();
const send = (c, o) => c.write(JSON.stringify(o) + '\n');
const broadcast = (o) => { for (const c of clients) send(c, o); };

let want = null;      // { view, rect }: what the app asked for
let cur = null;       // the connection camdec reads
let next = null;      // the connection being opened: its bytes held until its first IDR
let dec = null, paused = false;
let tries = 0, retryT = null;
let state = 'idle', msg = null, layout = null, rx = 0, rxT = Date.now();
let cams = [], events = [], picked = null, hero = null;

// shows: the view camdec is fed now (the old one until the new one's first IDR): what the app draws over
const stateEv = () => ({ ev: 'state', state, view: want ? want.view : null, msg, shows: cur ? cur.w.view : state === 'ended' ? 'clip' : null });
function setState(s, m) { state = s; msg = m || null; broadcast(stateEv()); }

const REFUSED = 'server refused this car';
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // no 0/O or 1/I: read off the screen, typed on the server
/** The car's code: the token the server knows this car by, 16 characters from CODE (80 bits) in groups of 4. */
const newCode = () => Array.from(require('crypto').randomBytes(16), (b) => CODE[b & 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
function readConf() {
    let t;
    try { t = fs.readFileSync(CONF, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    try { return JSON.parse(t); } catch (e) { throw new Error('server.json unreadable'); }   // (the parse error quotes the file: the code)
}
function writeConf(c) {
    fs.writeFileSync(CONF + '.tmp', JSON.stringify(c, null, 1) + '\n', { mode: 0o600 });
    fs.renameSync(CONF + '.tmp', CONF);
}
/** server.json as a checked config; makes the car's code at the first start. */
function conf() {
    let c = readConf();
    if (typeof c.token !== 'string' || !/^\S+$/.test(c.token)) { c.token = newCode(); writeConf(c); log('made the car\'s code'); }
    const st = fs.statSync(CONF);
    if (st.mode & 0o077) { fs.chmodSync(CONF, 0o600); log('server.json was readable by others: now 0600'); }
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/, hp = (v) => { const a = String(v).split(':'); return a.length === 2 && +a[1] > 0 && +a[1] < 65536 ? a : null; };
    const sk = hp(c.socks || '127.0.0.1:1065'), fb = c.socksFallback ? hp(c.socksFallback) : null;
    if (!c.host || c.host === '0.0.0.0') throw new Error('no server address: set it in Settings');
    if (!ip.test(c.host) || !(c.port > 0 && c.port < 65536) || !sk || (c.socksFallback && !fb)) throw new Error('server.json needs host (IPv4), port and socks host:port');
    const ll = typeof c.lat === 'number' && typeof c.lon === 'number' && Math.abs(c.lat) <= 90 && Math.abs(c.lon) <= 180;
    return { host: c.host, port: c.port, token: c.token, socksHost: sk[0], socksPort: +sk[1], fbHost: fb && fb[0], fbPort: fb && +fb[1],
        homeSsid: typeof c.homeSsid === 'string' ? c.homeSsid : null, lat: ll ? c.lat : null, lon: ll ? c.lon : null };
}
/** {"cmd":"config"} from the app's settings: merged into server.json (the token and homeSsid stay). */
function configure(m) {
    const n = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!(Array.isArray(m.host) && m.host.length === 4 && m.host.every((v) => n(v, 0, 255))) || !n(m.port, 1, 65535) || !n(m.socks, 1, 65535) ||
        !n(m.socksFallback, 0, 65535) || !n(m.lat, -90, 90) || !n(m.lon, -180, 180)) throw new Error('bad config');
    const c = readConf(), before = JSON.stringify(c), host = m.host.join('.');
    if (host !== '0.0.0.0') c.host = host;
    c.port = m.port;
    c.socks = '127.0.0.1:' + m.socks;
    if (m.socksFallback) c.socksFallback = '127.0.0.1:' + m.socksFallback; else delete c.socksFallback;
    if (m.lat || m.lon) { c.lat = m.lat; c.lon = m.lon; } else { delete c.lat; delete c.lon; }
    if (JSON.stringify(c) === before) return;
    const moved = JSON.parse(before || '{}').host !== c.host || JSON.parse(before || '{}').port !== c.port;
    writeConf(c);
    log('config: server ' + (c.host || 'not set') + ':' + c.port + ', socks ' + c.socks + (c.socksFallback ? ', fallback ' + c.socksFallback : ''));
    if (!moved) return rehero();
    cams = [];                                         // another server: its cameras, its events
    if (clients.size) { eventsClose(); eventsOpen(); list().then((l) => { cams = l; broadcast({ ev: 'list', cams }); rehero(); }, (e) => log('list:', e.message)); }
    if (want) { const w = want; stop('server changed', true); want = w; go(); }
}
// socksFallback: a second tunnel. A dead one costs socks.js' 5 s timeout once, then the fallback is used first for a
// minute so each view does not pay it again.
let fbUntil = 0;
function dial(c) {
    const main = () => socks.connect(c.socksHost, c.socksPort, c.host, c.port);
    if (!c.fbPort) return main();
    const fb = () => socks.connect(c.fbHost, c.fbPort, c.host, c.port).then((r) => { fbUntil = Date.now() + 60000; return r; });
    if (Date.now() < fbUntil) return fb().catch(() => { fbUntil = 0; return main(); });
    return main().catch((e) => { log('tunnel ' + c.socksPort + ': ' + e.message + ', trying ' + c.fbPort); return fb(); });
}

/* ---- the camera list: one request, the answer until the server closes ---- */
async function list() {
    const c = conf();
    const { sock, rest } = await dial(c);
    sock.write(c.token + ' list\n');
    return new Promise((resolve, reject) => {
        const bufs = [rest];
        let n = rest.length;
        sock.setTimeout(10000, () => sock.destroy(new Error('no answer')));
        sock.on('data', (d) => { bufs.push(d); if ((n += d.length) > 1048576) sock.destroy(new Error('camera list too big')); });
        sock.on('error', reject);
        sock.on('close', () => {
            const b = Buffer.concat(bufs);
            if (!b.length) return reject(new Error(REFUSED));
            try {
                const a = JSON.parse(b.toString('utf8'));
                if (!Array.isArray(a)) throw new Error();
                resolve(a.filter((x) => x && Number.isInteger(x.i)).map((x) => ({ i: x.i, name: str(x.name), label: str(x.label || x.name),
                    shape: SHAPES.indexOf(x.shape) >= 0 ? x.shape : 'wide', w: px(x.w), h: px(x.h),
                    roles: Array.isArray(x.roles) ? ROLES.filter((r) => x.roles.indexOf(r) >= 0) : [] })));
            } catch (e) { reject(new Error('bad answer from the server')); }
        });
    });
}
const str = (v) => String(v == null ? '' : v).slice(0, 60);
const px = (v) => (Number.isInteger(v) && v > 0 && v <= 16384 ? v : null);       // null: an older server (no size)

/* ---- the pane's order (serve.py arrange()): order[0] the camera at home in the hero's place, then the pane ---- */
/** The order with the hero in front, as the server arranges it (the hero and order[0] trade places). */
function effective(order, hero) {
    const p = order.slice(), k = p.indexOf(hero);
    if (k > 0) { p[k] = p[0]; p[0] = hero; }
    return p;
}
/** The order after camera a was dropped on b (ids: every camera, hero: the one shown big): a and b trade places as
 *  the user sees them; kept with the hero in front so that it reads the same whatever the hero is later. */
function swapped(order, ids, hero, a, b) {
    // none yet: the server's own (the hero, then the others in camera order)
    const base = (order || [hero]).filter((i, k, o) => ids.indexOf(i) >= 0 && o.indexOf(i) === k);
    ids.forEach((i) => { if (base.indexOf(i) < 0) base.push(i); });
    const p = effective(base, hero);
    const ka = p.indexOf(a), kb = p.indexOf(b);
    if (ka < 0 || kb < 0 || a === b) return p;
    p[ka] = b; p[kb] = a;
    return p;
}
let order = null;
try { const o = JSON.parse(fs.readFileSync(ORDER, 'utf8')); if (Array.isArray(o) && o.every(Number.isInteger)) order = o.slice(0, 64); } catch (e) { /* none yet */ }
function saveOrder(o) {
    order = o;
    try { fs.writeFileSync(ORDER + '.tmp', JSON.stringify(o), { mode: 0o600 }); fs.renameSync(ORDER + '.tmp', ORDER); } catch (e) { log('order.json:', e.message); }
}

/* ---- the hero: pure, so the test can call it ---- */
/** Night = before sunrise or after sunset (NOAA's approximation without the equation of time: a few minutes off). */
function isNight(d, lat, lon) {
    const r = Math.PI / 180;
    const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
    const decl = 23.44 * r * Math.sin(2 * Math.PI * (284 + doy) / 365);
    const cosH = (Math.sin(-0.833 * r) - Math.sin(lat * r) * Math.sin(decl)) / (Math.cos(lat * r) * Math.cos(decl));
    if (cosH <= -1) return false;                       // midnight sun
    if (cosH >= 1) return true;                         // polar night
    const half = Math.acos(cosH) / r / 15, noon = 12 - lon / 15, h = d.getUTCHours() + d.getUTCMinutes() / 60;
    return h < noon - half || h > noon + half;
}
/** { hero, why, event } from the events (newest last), the cameras (their roles), the user's pick, home (bool | null). */
function chooseHero(evs, list, pick, home, now, night) {
    const role = (r) => { const c = list.find((x) => (x.roles || []).indexOf(r) >= 0); return c ? c.i : null; };
    const doorCam = role('door');
    const latest = (ms, f) => { for (let k = evs.length - 1; k >= 0; k--) if (now - evs[k].ts <= ms && f(evs[k])) return evs[k]; return null; };
    const door = latest(120000, (e) => e.type === 'ring' || (e.type === 'person' && doorCam !== null && e.cam === doorCam));
    if (door && (door.type === 'ring' || pick === null)) return { hero: doorCam !== null ? doorCam : door.cam, why: door.type === 'ring' ? 'ring' : 'person', event: door };
    if (pick !== null) return { hero: pick, why: 'picked', event: null };
    const garage = home === true ? role('garage') : null;
    const e = latest(600000, (x) => ['person', 'vehicle', 'animal', 'package'].indexOf(x.type) >= 0 && x.cam !== garage);
    if (e) return { hero: e.cam, why: 'event', event: e };
    const d = night && role('night') !== null ? role('night') : role('day');
    return { hero: d !== null ? d : 0, why: 'default', event: null };
}
/** The car on the home Wi-Fi (mgu-uplink's status.json): true / false, null when unknown (no homeSsid, no file). */
function atHome(c) {
    if (!c || !c.homeSsid) return null;
    try {
        const w = JSON.parse(fs.readFileSync(UPLINK, 'utf8')).wifi || {};
        return (w.link === 'online' || w.link === 'connected') && w.ssid === c.homeSsid;
    } catch (e) { return null; }
}
function rehero() {
    if (!cams.length && !(want && want.view === 'spot')) return;     // the rules need the roles (the list comes first)
    let c = null;
    try { c = conf(); } catch (e) { /* defaults */ }
    const now = Date.now(), home = atHome(c), night = !!(c && c.lat !== null) && isNight(new Date(now), c.lat, c.lon);
    const h = Object.assign(chooseHero(events, cams, picked, home, now, night), { night, home });
    if (!hero || ['hero', 'why', 'night', 'home'].some((k) => h[k] !== hero[k]) || (h.event && h.event.ts) !== (hero.event && hero.event.ts)) {
        if (!hero || h.hero !== hero.hero) log('hero', h.hero, '(' + h.why + ')');
        hero = h;
        broadcast(Object.assign({ ev: 'hero' }, hero));
    }
    if (want && want.view === 'spot' && !retryT) go();
}

/* ---- the event feed: one long connection while an app is connected ---- */
let evSock = null, evTimer = null, evTries = 0, evGen = 0;
const event = (e) => (e && Number.isInteger(e.cam) && TYPES.indexOf(e.type) >= 0 && typeof e.ts === 'number' && (e.id === undefined || ID.test(String(e.id)))
    ? { id: e.id === undefined ? null : String(e.id), cam: e.cam, label: str(e.label), type: e.type, ts: e.ts, first: typeof e.first === 'number' ? e.first : e.ts, count: Number.isInteger(e.count) && e.count > 0 ? e.count : 1, thumb: e.thumb === true } : null);
/** A live event in the list: one with the same id (a burst that grew, its picture came) takes that row's place. */
function merge(e) {
    const k = e.id === null ? -1 : events.findIndex((x) => x.id === e.id);
    if (k >= 0) { if (e.thumb && !events[k].thumb) thumbs.delete(e.id); events.splice(k, 1); }
    events = events.concat(e).sort((a, b) => a.ts - b.ts).slice(-50);
}
function eventsOpen() {
    if (!clients.size || evSock || evTimer) return;
    let c;
    try { c = conf(); } catch (e) { return eventsLater(); }
    const gen = ++evGen;
    evSock = 'dialing';
    dial(c).then(({ sock, rest }) => {
        if (gen !== evGen) return sock.destroy();
        evSock = sock;
        sock.write(c.token + ' events\n');
        sock.setTimeout(EVENTS_SILENT_MS, () => sock.destroy());
        let buf = '', got = false;
        const data = (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m; try { m = JSON.parse(line); } catch (x) { continue; }
                got = true;
                if (m.ev === 'events' && Array.isArray(m.list)) { events = m.list.map(event).filter(Boolean).sort((x, y) => x.ts - y.ts).slice(-50); broadcast({ ev: 'events', list: events }); } else if (m.ev === 'event') {
                    const e = event(m);
                    if (!e) continue;
                    merge(e);
                    broadcast(Object.assign({ ev: 'event' }, e));
                    if (e.type === 'ring' && picked !== null) { log('doorbell: the camera picked gives way'); picked = null; }
                }
                rehero();
            }
            if (buf.length > 1 << 20) buf = '';
        };
        sock.setEncoding('utf8');
        if (rest.length) data(rest.toString('utf8'));
        sock.on('data', data);
        sock.on('error', () => {});
        sock.on('close', () => { if (gen !== evGen) return; evSock = null; if (got) evTries = 0; eventsLater(); });
    }, () => { if (gen === evGen) { evSock = null; eventsLater(); } });
}
function eventsLater() {
    if (!clients.size || evTimer) return;
    const ms = BACKOFF[Math.min(evTries++, BACKOFF.length - 1)];
    evTimer = setTimeout(() => { evTimer = null; eventsOpen(); }, ms);
}
function eventsClose() {
    evGen++;
    clearTimeout(evTimer); evTimer = null;
    if (evSock && evSock !== 'dialing') evSock.destroy();
    evSock = null; evTries = 0;
}

/* ---- an event's picture: `<token> thumb <id>` -> JPEG then close (nothing: none); 160x90 RGBA for the app ---- */
const thumbs = new Map();        // id -> Buffer (RGBA) | null (none): an LRU, the most recent last
const thumbWait = new Map();     // id -> [ctl connections] waiting for it
const thumbQ = [];
let thumbJobs = 0;
function thumbSend(c, id, rgba) {
    if (c.destroyed) return;
    send(c, rgba ? { ev: 'thumb', id, w: THUMB_W, h: THUMB_H, rgba: rgba.toString('base64') } : { ev: 'thumb', id, none: true });
}
function thumb(c, id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('bad thumb id');
    const e = events.find((x) => x.id === id);
    if (e && !e.thumb) return thumbSend(c, id, null);                // the server has none (yet: an update says)
    if (thumbs.has(id) && (thumbs.get(id) || !e)) { const v = thumbs.get(id); thumbs.delete(id); thumbs.set(id, v); return thumbSend(c, id, v); }
    if (thumbWait.has(id)) return thumbWait.get(id).push(c);
    thumbWait.set(id, [c]);
    thumbQ.push(id);
    thumbRun();
}
function thumbRun() {
    while (thumbJobs < THUMB_JOBS && thumbQ.length) {
        const id = thumbQ.shift();
        thumbJobs++;
        thumbFetch(id).then((jpeg) => (jpeg.length ? scale(decodeJpeg(jpeg, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 2, maxMemoryUsageInMB: 32 })) : null))
            .catch((e) => { log('thumb', id + ':', e.message); return undefined; })
            .then((v) => {
                thumbJobs--;
                if (v !== undefined) { thumbs.set(id, v); while (thumbs.size > THUMB_LRU) thumbs.delete(thumbs.keys().next().value); }
                const cs = thumbWait.get(id) || [];
                thumbWait.delete(id);
                cs.forEach((c) => thumbSend(c, id, v || null));
                thumbRun();
            });
    }
}
async function thumbFetch(id) {
    const c = conf();
    const { sock, rest } = await dial(c);
    sock.write(c.token + ' thumb ' + id + '\n');
    return new Promise((resolve, reject) => {
        const bufs = [rest];
        let n = rest.length;
        sock.setTimeout(10000, () => sock.destroy(new Error('no answer')));
        sock.on('data', (d) => { n += d.length; if (n > THUMB_MAX) sock.destroy(new Error('over 1 MB')); else bufs.push(d); });
        sock.on('error', reject);
        sock.on('close', (err) => { if (!err) resolve(Buffer.concat(bufs)); });
    });
}
/** A decoded picture (any size) as THUMB_W x THUMB_H RGBA, each pixel the mean of its box. */
function scale(img) {
    const out = Buffer.alloc(THUMB_W * THUMB_H * 4), sw = img.width, sh = img.height, d = img.data;
    for (let y = 0; y < THUMB_H; y++) {
        const y0 = Math.floor(y * sh / THUMB_H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / THUMB_H));
        for (let x = 0; x < THUMB_W; x++) {
            const x0 = Math.floor(x * sw / THUMB_W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / THUMB_W));
            let r = 0, g = 0, b = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const s = (yy * sw + xx) * 4; r += d[s]; g += d[s + 1]; b += d[s + 2]; }
            const k = (x1 - x0) * (y1 - y0), o = (y * THUMB_W + x) * 4;
            out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k; out[o + 3] = 255;
        }
    }
    return out;
}

/* ---- Annex-B: start codes (00 00 01; a 4-byte one's leading zero counts as the NAL before's trailing zero) ---- */
/** [{ at, type }] of the start codes in b whose type byte is in b, from index `from`. */
function starts(b, from) {
    const r = [];
    for (let i = from; i + 3 < b.length; i++) {
        if (b[i + 2] > 1) { i += 2; continue; }
        if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) r.push({ at: i, type: b[i + 3] & 0x1f });
    }
    return r;
}
/** Index of the last start code in b at or after `from`, -1 if none (its type byte may still be coming). */
function lastStart(b, from) {
    for (let i = b.length - 3; i >= from; i--) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) return i;
    return -1;
}

/** Layout line from the server (trust boundary): numbers and short strings only. */
function parseLayout(s) {
    const o = JSON.parse(s), n = (v) => typeof v === 'number' && isFinite(v);
    const rect = (r) => (r && n(r.x) && n(r.y) && n(r.w) && n(r.h) ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
    if (!o || !n(o.w) || !n(o.h) || !Array.isArray(o.tiles)) throw new Error('bad layout');
    const tiles = o.tiles.filter((t) => t && Number.isInteger(t.i) && rect(t)).map((t) => Object.assign({ i: t.i, name: str(t.name), label: str(t.label || t.name) },
        rect(t), { shape: SHAPES.indexOf(t.shape) >= 0 ? t.shape : 'wide' }));
    return { w: o.w, h: o.h, hero: Number.isInteger(o.hero) ? o.hero : null, heroRect: rect(o.heroRect), pane: rect(o.pane), tiles };
}
/** A clip's line from the server (trust boundary): { error: code } or { id, cam, label, type, start, dur }. */
function parseClip(s) {
    const o = JSON.parse(s), n = (v) => typeof v === 'number' && isFinite(v);
    if (!o || o.ev !== 'clip') throw new Error('bad clip line');
    if (o.error !== undefined) return { error: str(o.error) };
    if (!n(o.start) || !n(o.dur) || o.dur <= 0) throw new Error('bad clip line');
    return { id: str(o.id), cam: Number.isInteger(o.cam) ? o.cam : null, label: str(o.label), type: TYPES.indexOf(o.type) >= 0 ? o.type : null, start: o.start, dur: o.dur };
}

/* ---- a view's connection ---- */
/** The request (without the token) for a view: the spot's hero is ours. */
function reqOf(w) {
    if (w.view === 'clip') return 'clip ' + w.id + ' ' + w.rect;
    if (w.view === 'spot') return 'spot ' + (hero ? hero.hero : 0) + ' ' + (order ? 'o=' + order.join(',') + ' ' : '') + w.rect;
    return (w.view === 'mosaic' ? 'mosaic2 ' : 'cam ' + w.view + ' ') + w.rect;
}
function open(w) {
    const req = reqOf(w);
    const conn = next = { w, req, sock: null, line: /^(spot|mosaic2|clip) /.test(req) ? [] : null, lineLen: 0, layout: null, parts: [], len: 0, carry: null, sps: -1, held: null, why: null, bytes: 0 };
    setState('connecting');
    let c;
    try { c = conf(); } catch (e) { return closed(conn, e.message); }
    log('view', req);
    dial(c).then(({ sock, rest }) => {
        if (next !== conn) return sock.destroy();
        conn.sock = sock;
        const first = w.view === 'clip' ? CLIP_FIRST_MS : FIRST_MS;
        sock.setTimeout(first, () => { conn.why = conn.why || (conn === cur ? 'stream stalled' : 'no picture from the server in ' + first / 1000 + ' s'); sock.destroy(); });
        sock.on('data', (d) => onData(conn, d));
        sock.on('error', (e) => { conn.why = conn.why || e.message; });
        sock.on('close', () => closed(conn, conn.why || (conn.bytes ? 'connection lost' : REFUSED)));
        sock.write(c.token + ' ' + req + '\n');
        if (rest.length) onData(conn, rest);
    }, (e) => closed(conn, 'tunnel: ' + e.message));
}

function fail(conn, why) { conn.why = why; if (conn.sock) conn.sock.destroy(); else closed(conn, why); }

function onData(conn, d) {
    conn.bytes += d.length;
    if (conn === cur) { rx += d.length; return live(d); }
    if (conn !== next) return;
    if (conn.line) {                                   // spot / mosaic2 / clip: the server's line before the H.264
        const k = d.indexOf(10);
        if (k < 0) {
            conn.line.push(d); conn.lineLen += d.length;
            if (conn.lineLen > 65536) fail(conn, 'bad layout from the server');
            return;
        }
        conn.line.push(d.slice(0, k));
        const txt = Buffer.concat(conn.line).toString('utf8');
        if (conn.w.view === 'clip') {
            try { conn.clip = parseClip(txt); } catch (e) { conn.clipErr = 'Video unavailable (bad answer from the server)'; return fail(conn, 'bad clip line'); }
            if (conn.clip.error) { conn.clipErr = CLIP_ERR.hasOwnProperty(conn.clip.error) ? CLIP_ERR[conn.clip.error] : 'Video unavailable'; return fail(conn, 'server: ' + conn.clip.error); }
        } else {
            try { conn.layout = parseLayout(txt); } catch (e) { return fail(conn, 'bad layout from the server'); }
        }
        conn.line = null;
        d = d.slice(k + 1);
    }
    // held until the first IDR; the start codes found across chunks (carry: the last 3 bytes)
    const base = conn.len - (conn.carry ? conn.carry.length : 0), s = conn.carry ? Buffer.concat([conn.carry, d]) : d;
    conn.parts.push(d); conn.len += d.length;
    conn.carry = s.slice(Math.max(0, s.length - 3));
    for (const n of starts(s, 0)) {
        if (n.type === 7) conn.sps = base + n.at;
        if (n.type === 5 && conn.sps >= 0) return switchTo(conn, Buffer.concat(conn.parts).slice(conn.sps));
    }
    if (conn.len > MAX_PENDING) fail(conn, 'no picture start from the server');
}

/** The new stream's first IDR is in: camdec reads it from its SPS on, the old connection goes. */
function switchTo(conn, data) {
    const old = cur;
    cur = conn; next = null;
    conn.parts = null; conn.carry = null;
    if (old) old.sock.destroy();                       // (its rest after the last start code is dropped)
    paused = false;
    conn.sock.setTimeout(SILENT_MS);
    layout = conn.layout;
    if (layout) broadcast(Object.assign({ ev: 'layout' }, layout));
    if (conn.clip) broadcast(Object.assign({ ev: 'clip' }, conn.clip));
    decoder();
    rx = data.length; rxT = Date.now();
    write(data);
    setState('playing');
    log('playing', conn.req);
}

/** Bytes of the live stream; while another view connects, only whole NALs (cut before the last start code). */
function live(d) {
    if (!next) {
        if (cur.held) { d = Buffer.concat([cur.held, d]); cur.held = null; }
        return write(d);
    }
    const b = cur.held ? Buffer.concat([cur.held, d]) : d;
    const k = lastStart(b, cur.held ? 1 : 0);
    if (k < 0) { cur.held = b; return; }
    write(b.slice(0, k));
    cur.held = b.slice(k);
}

function write(b) {
    if (!dec || !b.length) return;
    if (dec.stdin.write(b) || !cur || paused) return;
    paused = true;
    const s = cur.sock;
    s.pause();
    dec.stdin.once('drain', () => { paused = false; s.resume(); });
}

/** A connection ended: ours (the one shown or the one opening) -> retry with backoff; the picture stays meanwhile. */
function closed(conn, why) {
    if (conn !== cur && conn !== next) return;
    const played = conn === cur;
    if (conn === cur) cur = null; else next = null;
    if (!want || next) return;                         // stopped, or another one is on its way
    if (conn.w.view === 'clip') {                      // a recording plays once: its end (or a drop) is the end
        log('clip', conn.req, played ? 'ended' : 'failed: ' + why);
        return played ? setState('ended') : setState('error', conn.clipErr || 'Video unavailable (' + why + ')');
    }
    log('view', conn.req, 'ended:', why);
    retry(why);
}
function retry(why) {
    const ms = BACKOFF[Math.min(tries, BACKOFF.length - 1)];
    tries++;
    let say = why;                                     // the refused car's code: shown, never logged
    if (why === REFUSED) try { say = 'Server refused this car: add code ' + conf().token + ' on the server'; } catch (e) { /* the why */ }
    setState('error', say + ' - retry in ' + ms / 1000 + ' s');
    clearTimeout(retryT);
    retryT = setTimeout(() => { retryT = null; if (want && !next && !cur) open(want); else if (want) go(); }, ms);
}

/* ---- camdec ---- */
const EXIT = { 1: 'decoder init failed', 2: 'decoder: bad arguments or video file not writable', 70: 'decoder crashed' };
function decoder() {
    if (dec) return;
    const c = dec = spawn(BIN, ['--out', VIDEO], { stdio: ['pipe', 'pipe', 'inherit'] });
    let ended = false;
    const end = (code) => {
        if (ended) return;
        ended = true;
        if (dec === c) { dec = null; paused = false; }
        log('camdec exited', code);
        if (want && cur && cur.sock) fail(cur, EXIT[code] || 'decoder exited (' + code + ')');   // a fresh connection: a fresh IDR
    };
    c.stdin.on('error', () => { /* it died: exit says */ });
    let buf = '';
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            let e; try { e = JSON.parse(line); } catch (x) { continue; }
            if (e.ev === 'stats') {
                if (c !== dec) continue;
                if (cur) tries = 0;                        // a decoder that runs: the backoff starts again from 1 s
                const now = Date.now(), kbps = Math.round(rx * 8 / Math.max(1, now - rxT));
                rx = 0; rxT = now;
                broadcast(Object.assign({}, e, { ev: 'stats', kbps }));
            } else if (e.ev === 'ready') log('camdec ready', e.w + 'x' + e.h, e.fps + ' fps');
            else if (e.ev === 'error') log('camdec:', String(e.msg).slice(0, 200));
        }
        if (buf.length > 1 << 16) buf = '';
    });
    c.on('exit', (code, sig) => end(sig || code));
    c.on('error', (e) => { log('camdec spawn failed:', e.message); end(-1); });
}

/* ---- commands ---- */
function stop(why, keepPick) {
    if (why && (want || dec)) log('stop:', why);
    want = null;
    if (!keepPick) picked = null;                      // the pick lasts while the user is in the app (driving off keeps it)
    clearTimeout(retryT); retryT = null;
    for (const c of [cur, next]) if (c && c.sock) c.sock.destroy();
    cur = next = null; layout = null;
    if (dec) {
        const c = dec;
        dec = null;
        c.stdin.end();
        setTimeout(() => { if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL'); }, 1000);
    }
    if (state !== 'idle') setState('idle');
}

/** Bring the stream to what `want` asks now (a new view, or the spot's new hero). */
function go() {
    const req = reqOf(want);
    if (next && next.req === req) return;
    if (cur && cur.req === req && !next) return;
    tries = 0;
    clearTimeout(retryT); retryT = null;
    if (next) { const n = next; next = null; if (n.sock) n.sock.destroy(); }
    if (cur && cur.req === req) {                                   // back to what still plays
        if (cur.held) { write(cur.held); cur.held = null; }
        if (layout) broadcast(Object.assign({ ev: 'layout' }, layout));
        return setState('playing');
    }
    open(want);
}

function view(m) {
    const v = m.view === 'mosaic' || m.view === 'spot' || m.view === 'clip' ? m.view : Number.isInteger(m.view) && m.view >= 0 && m.view < 64 ? m.view : null;
    const r = /^(\d{2,4})x(\d{2,4})$/.exec(String(m.rect || ''));
    if (v === null || !r || +r[1] > 2048 || +r[2] > 2048 || r[1] % 2 || r[2] % 2) throw new Error('bad view or rect');
    const id = v === 'clip' ? m.id : undefined;
    if (v === 'clip' && (typeof id !== 'string' || !ID.test(id))) throw new Error('bad clip id');
    if (want && want.view === v && want.id === id && want.rect === r[0] && (cur || next || retryT)) return;   // already there or on its way
    want = { view: v, rect: r[0], id };
    if (v === 'spot' && !hero) rehero();
    go();
}

async function handle(c, m) {
    switch (m.cmd) {
    case 'status':
        send(c, stateEv());
        if (layout && cur) send(c, Object.assign({ ev: 'layout' }, layout));
        if (hero) send(c, Object.assign({ ev: 'hero' }, hero));
        return send(c, { ev: 'events', list: events });
    case 'list': cams = await list(); broadcast({ ev: 'list', cams }); return rehero();
    case 'view': return view(m);
    case 'config': return configure(m);
    case 'pick':
        if (!Number.isInteger(m.cam) || m.cam < 0 || m.cam >= 64) throw new Error('bad camera');
        picked = m.cam;
        return rehero();
    case 'thumb': return thumb(c, m.id);
    case 'swap': {
        const ids = cams.map((x) => x.i), h = hero ? hero.hero : null;
        if (!Number.isInteger(m.a) || !Number.isInteger(m.b) || ids.indexOf(m.a) < 0 || ids.indexOf(m.b) < 0 || h === null) throw new Error('bad swap');
        saveOrder(swapped(order, ids, h, m.a, m.b));
        log('order', order.join(','));
        if (m.b === h || m.a === h) picked = m.a === h ? m.b : m.a;     // onto the hero (or the hero onto a tile): the new hero
        return rehero();
    }
    case 'stop': return stop('asked' + (m.why ? ' (' + String(m.why).slice(0, 20) + ')' : ''), m.why === 'moving');
    default: throw new Error('unknown cmd');
    }
}

function serve() {
    try { fs.unlinkSync(CTL); } catch (e) { /* none */ }
    const srv = net.createServer((c) => {
        clients.add(c);
        eventsOpen();
        // the roles the hero's rules use: before a spot is asked
        if (!cams.length) list().then((l) => { cams = l; rehero(); }, (e) => log('list:', e.message));
        c.setEncoding('utf8');
        let buf = '';
        c.on('data', (d) => {
            buf += d;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i); buf = buf.slice(i + 1);
                let m; try { m = JSON.parse(line); } catch (e) { continue; }
                if (!m || typeof m.cmd !== 'string') continue;
                handle(c, m).catch((e) => { log(m.cmd, 'failed:', e.message); broadcast({ ev: 'error', cmd: m.cmd, msg: e.message }); });
            }
            if (buf.length > 1 << 16) buf = '';
        });
        c.on('error', () => {});
        c.on('close', () => { clients.delete(c); if (!clients.size) { stop('last app connection gone'); eventsClose(); } });
    });
    srv.on('error', (e) => log('ctl listen failed:', e.message));
    srv.listen(CTL, () => { try { fs.chmodSync(CTL, 0o660); } catch (e) { /* tmpfs without chmod */ } log('ctl on', CTL); });
    // windows expire and night falls without any event
    setInterval(() => { if (clients.size) rehero(); }, 30000).unref();
}

if (require.main === module) {
    process.on('uncaughtException', (e) => log('uncaught:', e.stack || e));
    process.on('unhandledRejection', (e) => log('unhandled:', e && e.stack || e));
    process.on('SIGTERM', () => { stop('SIGTERM'); eventsClose(); setTimeout(() => process.exit(0), 1200); });
    try { conf(); } catch (e) { /* no address yet: the code is made all the same */ }
    serve();
}
module.exports = { chooseHero, isNight, parseLayout, scale, effective, swapped, newCode };
