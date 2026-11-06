'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
/**
 * RideWatch (jap_ridewatch) - the UniFi Protect cameras on the whole screen, parked. The jap-ridewatch tool does the work
 * (ridewatchd.js, Node 22: the stream from the RideWatch server, camdec decoding it into /dev/shm/mgu-video-ridewatch, the
 * event feed and the choice of the hero camera); this app is its face over ctl.js. The server draws the pictures at
 * exactly the size asked here (rect(): the kit's placement), so the stream's pixels are the screen's: the overlay is
 * drawn in screen px (xf(1, 0, 0)), the targets in the kit's page px.
 *
 * Screens:
 *   VIEW  the spot view, drawn by the kit (first canvas screen, "fill": the whole screen): the server's spot picture
 *         (the hero big on the left, the other cameras in the pane on the right, all in the video) and over it, from
 *         the daemon's {"ev":"layout"} (the server's rects: nothing here assumes them) and {"ev":"hero"}: the hero's
 *         name and its last event bottom left, the clock and Day/Night top right, each pane tile's label, a golden
 *         ring round the hero for a ring or a person at the door, a banner for a live event (both fade).
 *         Two tabs top left, drawn here ("fill" has no kit header): "Live" and "What happened" (the timeline: a
 *         panel over the pane, every interesting event newest first, thumbnails, day headers, a gold scroll bar; a
 *         finger drags it with inertia, the controller goes row by row). The hero stays live on both.
 *         Tap / press a pane tile: that camera becomes the hero (the daemon's sticky pick). A timeline row: its clip.
 *         Tap / press the hero: CAM. Controller pushed left on the timeline: back to "Live".
 *         Hold a tile (0.45 s) or drag it: it lifts (a live ghost under the finger); dropped on a tile of the same
 *         shape the two trade places, on the hero it becomes the hero ({"cmd":"swap"}: the daemon keeps the order).
 *   CAM   one camera on the whole screen: the app's own mgu-render connection (mgu_render_client.js, Moonride's
 *         GAME pattern: layer mode, PLACE + CLAIM the whole screen, VIDEO id 1, op 19). Its own screen so that the
 *         HMI's BACK comes back to VIEW; a tap or a press does the same, a turn goes to the next / previous camera.
 *         The picture fills the screen (frame.js: the stream's frame scaled, the renderer clips it), a finger or
 *         the controller pushed up / down pans it; the chip bottom right (or the controller pushed right) shows it
 *         whole. The hero's CAM is the spot stream already playing (its hero is the same 1280x720 picture): no new
 *         stream, so it opens at once; another camera keeps the last picture, dimmed, until its own is in.
 *         An event's clip ({"cmd":"view","view":"clip","id"}: its recording from Protect, played once) on the
 *         same screen: "Person · Door · 14:32" and a gold progress bar from the clip's `dur`; at the end the last
 *         frame stays with "Replay" (the clip again) and "Live" (that camera live, CAM as above, and the pick).
 * States: connecting (only while there is no picture yet: a new view keeps the old one until its first real
 * picture), the daemon's error message, "parked only", the service not running. Parked only (setting parkedOnly, on
 * by default): above 3 km/h, or no speed at all, no stream. Hidden (life.js: INACTIVE) -> {"cmd":"stop"} (the
 * daemon then forgets the pick). The settings' server address, ports and location go to the daemon as
 * {"cmd":"config"} when it connects and on every change. Never exits on an error.
 */
const fs = require('fs');
const mgu = require('./kit/mgu');
const record = require('./kit/record');
const { Recorder, setImage } = record;
const Parked = require('./kit/parked');
const { Ctl } = require('./ctl');
const { RenderClient } = require('./mgu_render_client');
const F = require('./frame');

const W = 1600, H = 520;                 // the kit's page ("fill": scaled over the whole screen)
const VID = 1, VPATH = process.env.JAP_RIDEWATCH_VIDEO || '/dev/shm/mgu-video-ridewatch';
const KEEPALIVE_MS = 500;                // the renderer hides an app silent for 3 s
const POOL0 = 8, POOL = 24;              // picture ids for the timeline's thumbs (the renderer holds 64 an app)
const LIT = { literal: true }, BOLD = { literal: true, font: 'bold' };
const GOLD = '#F0C068', DOT = '#E8B45A', SUB = '#ffffffd1', DIM = '#ffffff99';
const TYPE = { person: 'Person', vehicle: 'Vehicle', animal: 'Animal', package: 'Package', motion: 'Motion', ring: 'Ring' };
const TIMELINE = ['person', 'vehicle', 'animal', 'package', 'ring'];   // what the timeline lists (never plain motion)
const RECENT_MS = 600000;                // the gold dot: an event of the last 10 min
const TOP = 24, ROW = 114, HEAD = 52;    // the timeline: list top, row and day header heights (screen px)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad = (n) => (n < 10 ? '0' : '') + n;
const hexA = (a) => ('0' + Math.max(0, Math.min(255, Math.round(a * 255))).toString(16)).slice(-2);
const hhmm = (t) => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const dayOf = (t) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const yesterday = (now) => dayOf(dayOf(now) - 12 * 3600000);
/** "just now", "4 min ago", "14:02" (today), "yesterday 21:14", "3 Nov 08:10" (the unit's local time) */
function rel(t, now) {
    const s = (now - t) / 1000, day = dayOf(t);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' min ago';
    if (day === dayOf(now)) return hhmm(t);
    if (day === yesterday(now)) return 'yesterday ' + hhmm(t);
    const d = new Date(t);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + hhmm(t);
}
function dayName(t, now) {
    const day = dayOf(t), d = new Date(t);
    if (day === dayOf(now)) return 'Today';
    if (day === yesterday(now)) return 'Yesterday';
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS_LONG[d.getMonth()];
}

process.on('uncaughtException', (e) => { try { mgu.log.error('uncaught', e); } catch (x) { /* nothing left to log with */ } });
process.on('unhandledRejection', (e) => { try { mgu.log.error('unhandled rejection: ' + ((e && e.stack) || e)); } catch (x) { /* idem */ } });

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const safe = (what, fn) => function () { try { return fn.apply(null, arguments); } catch (e) { log.error(what, e); } };
        const parked = Parked.watch(ctx, log, { strict: true });
        const moving = () => settings.get('parkedOnly') !== false && parked.moving();

        /* ---------- the daemon ---------- */
        const st = { up: false, state: 'idle', view: null, shows: undefined, msg: null, cams: [], layout: null, pic: false, hero: null, events: [] };
        const thumbs = {}, asked = new Set(), none = new Set();     // id -> { w, h, buf }; ids asked; ids with no picture
        let sent = null, dirty = true;           // sent: the last view asked ("spot 1920x720"), 'stop' or null
        let heroT = 0, banner = null;            // when the hero changed (its name fades in); the live event's banner
        const ctl = new Ctl(log);
        // the settings the service needs (ridewatchd.js configure()): sent first, so the list goes to the right server
        const num = (k) => (Number.isInteger(settings.get(k)) ? settings.get(k) : 0);
        const config = () => ctl.send({ cmd: 'config', host: [num('server1'), num('server2'), num('server3'), num('server4')], port: num('port') || 18640,
            socks: num('socks') || 1065, socksFallback: num('socksFallback'), lat: num('lat'), lon: num('lon') });
        ctl.on('up', safe('ctl up', () => { st.up = true; sent = null; asked.clear(); config(); ctl.send({ cmd: 'status' }); ctl.send({ cmd: 'list' }); dirty = true; }));
        ctl.on('down', safe('ctl down', () => { st.up = false; st.state = 'idle'; st.pic = false; sent = null; dirty = true; }));
        const isEv = (e) => e && typeof e.id === 'string' && Number.isInteger(e.cam) && !!TYPE[e.type] && typeof e.ts === 'number';
        ctl.on('msg', safe('ctl msg', (m) => {
            if (m.ev === 'state') {
                if (m.state !== st.state) log.info('jap-ridewatch: ' + m.state + (m.msg ? ' (' + m.msg + ')' : ''));
                st.state = m.state; st.view = m.view; st.msg = m.msg || null;
                if ('shows' in m) st.shows = m.shows;
                if (m.state === 'playing') { st.pic = true; if (!st.cams.length) ctl.send({ cmd: 'list' }); }
                if (m.state === 'idle') { st.pic = false; if (sent !== 'stop') sent = null; }   // stopped under us: asked again
                if (clip) clip.ended = m.state === 'ended';
                camRec = null; setImmediate(safe('sync', sync));    // CAM's framing follows the stream at once, not at the next tick
            } else if (m.ev === 'list') st.cams = (Array.isArray(m.cams) ? m.cams : []).filter((c) => c && Number.isInteger(c.i));
            else if (m.ev === 'clip') { if (clip && m.id === clip.e.id && m.dur > 0) { clip.info = m; clip.t0 = Date.now(); } camRec = null; }
            else if (m.ev === 'layout') { st.layout = Array.isArray(m.tiles) && m.w > 0 && m.h > 0 ? m : null; swapAsk = null; camRec = null; }
            else if (m.ev === 'hero') {
                if (!Number.isInteger(m.hero)) return;
                if (!st.hero || st.hero.hero !== m.hero || st.hero.why !== m.why) heroT = Date.now();
                st.hero = m;
            } else if (m.ev === 'events') { st.events = (Array.isArray(m.list) ? m.list : []).filter(isEv); prune(); } else if (m.ev === 'event') {
                if (!isEv(m)) return;
                const e = { id: m.id, cam: m.cam, label: m.label, type: m.type, ts: m.ts, first: m.first, count: m.count || 1, thumb: !!m.thumb };
                const k = st.events.findIndex((x) => x.id === e.id);
                if (k >= 0) {
                    if (e.thumb && none.has(e.id)) none.delete(e.id);          // its picture came: asked again
                    st.events.splice(k, 1);
                } else if (TIMELINE.indexOf(e.type) >= 0) banner = { e, t0: Date.now() };
                st.events = st.events.concat(e).sort((a, b) => a.ts - b.ts).slice(-50);
                prune();
            } else if (m.ev === 'thumb') {
                asked.delete(m.id);
                if (m.none) { none.add(m.id); return; }
                const buf = typeof m.rgba === 'string' ? Buffer.from(m.rgba, 'base64') : null;
                if (!buf || m.w !== 160 || m.h !== 90 || buf.length !== 160 * 90 * 4 || !st.events.some((e) => e.id === m.id)) return;
                thumbs[m.id] = { w: m.w, h: m.h, buf };
            } else if (m.ev === 'error') log.warn('jap-ridewatch: ' + m.cmd + ': ' + m.msg);
            else if (m.ev === 'stats') return;
            dirty = true;
        }));
        // the thumbs of events no longer listed go
        function prune() { Object.keys(thumbs).forEach((id) => { if (!st.events.some((e) => e.id === id)) delete thumbs[id]; }); }
        // a row drawn asks for its picture (at most 4 on their way)
        function wantThumb(e) {
            if (!e.thumb || thumbs[e.id] || asked.has(e.id) || none.has(e.id) || asked.size >= 4) return;
            if (ctl.send({ cmd: 'thumb', id: e.id })) asked.add(e.id);
        }
        ctl.connect();
        const name = (i) => {
            const c = st.cams.find((x) => x.i === i), t = st.layout && st.layout.tiles.find((x) => x.i === i);
            return c && (c.label || c.name) ? c.label || c.name : t && t.label ? t.label : 'Camera ' + (i + 1);
        };
        const lastOf = (i) => { for (let k = st.events.length - 1; k >= 0; k--) if (st.events[k].cam === i && TIMELINE.indexOf(st.events[k].type) >= 0) return st.events[k]; return null; };

        /* ---------- what is shown, what is asked ---------- */
        let cam = null;                          // the camera CAM shows
        let clip = null, clipCam = null, clipSel = 0;   // CAM's clip ({ e, n: replays, info, t0, ended }); its camera; the knob's button
        let tab = 'live';                        // VIEW's tab: 'live' | 'past'
        const shown = (n) => ui.isVisible(n) && (!ui.hasFocus || ui.hasFocus(n));
        // the size the server encodes at: the kit's placement (the whole screen), as the YouTube app's rect()
        function rect() {
            const pl = (ctx.display && ctx.display.place && ctx.display.place.full ? ctx.display.place : null) || gpu.placement || { w: 1920, h: 720 };
            const even = (v) => Math.min(2048, Math.max(16, Math.round(v / 2) * 2));
            return even(pl.w) + 'x' + even(pl.h);
        }
        const frameSize = () => { const m = rect().split('x'); return { w: +m[0], h: +m[1] }; };   // every view's frame
        const camOf = (i) => st.cams.find((c) => c.i === i) || {};
        const camW = (i) => camOf(i).w, camH = (i) => camOf(i).h;
        // CAM's camera is the picked hero: back on VIEW it is the one shown big, and no event takes it away meanwhile
        function open(i) { camTo(i); ui.open('CAM'); sync(); }
        function back() { if (ui.isVisible('CAM')) ui.open('VIEW'); }
        function pick(i, id) { ctl.send({ cmd: 'pick', cam: i }); sel = id || null; dirty = true; }
        function turn(d) {
            const ids = st.cams.length ? st.cams.map((c) => c.i) : (st.layout ? st.layout.tiles.map((t) => t.i) : []);
            if (!ids.length) return;
            const k = ids.indexOf(cam);
            camTo(ids[((k < 0 ? 0 : k + d) % ids.length + ids.length) % ids.length]);
            sync();
        }
        function camTo(i) { cam = i; camPan = { x: 0, y: 0 }; wake(); ctl.send({ cmd: 'pick', cam: i }); }
        // a timeline row: its clip on CAM (no pick: "Direct" does that)
        // on the car openState('CAM') once failed (INVALID_COMPONENTID) and the clip stayed half-open: check, retry once
        function playClip(e, how) {
            clip = { e, n: 0, info: null, t0: 0, ended: false }; clipCam = cam = e.cam; clipSel = 0; sel = e.id; camPan = { x: 0, y: 0 }; flash = null; wake();
            log.info('clip ' + e.id + ' (' + (how || 'target') + ')');
            const c = clip, opened = () => ui.isVisible('CAM') || clip !== c;
            const check = (again) => setTimeout(safe('clip open', () => {
                if (opened()) return;
                if (again) { log.warn('clip ' + e.id + ': CAM did not open, again'); Promise.resolve(ui.open('CAM')).then(() => check(false)); return; }
                log.warn('clip ' + e.id + ': CAM did not open'); clip = null; flash = { s: 'The clip did not open, tap it again', t: Date.now() }; dirty = true; sync();
            }), 1500);
            Promise.resolve(ui.open('CAM')).then(() => check(true));
            sync();
        }
        function replay() { clip.n++; clip.info = null; clip.ended = false; wake(); sync(); }
        function direct() { const i = clip.e.cam; clip = null; camTo(i); sync(); }
        function setTab(t) { if (t !== tab) { tab = t; vel = 0; scrollTo = null; dirty = true; } }

        /* ---------- VIEW: concept A, drawn by the kit ---------- */
        const kgpu = () => (ctx.display && ctx.display.gpu && ctx.display.gpu.native ? ctx.display.gpu : null);
        let kIno = null, last = null, lastT = 0, focus = null, sel = null;
        let flash = null;                        // a short message over VIEW ({ s, t }), 5 s
        let scrollY = 0, scrollTo = null, vel = 0, drag = null, rows = [], listH = 0, frameT = Date.now();
        // the pane: the server's, else right of the hero
        const pane = () => {
            const L = st.layout;
            if (L && L.pane) return L.pane;
            const x = L && L.heroRect ? L.heroRect.x + L.heroRect.w : L && L.tiles.length ? Math.min.apply(null, L.tiles.map((t) => t.x)) : 1280;
            return { x, y: 0, w: (L ? L.w : 1920) - x, h: L ? L.h : 720 };
        };
        // shortcut: the timeline and its touch use the layout's px as screen px (true while rect() asks the server for
        // exactly the placement's size); scale by pl.w / L.w like drawSpot if that ever differs
        const viewH = () => pane().h - TOP;
        const maxScroll = () => Math.max(0, listH - viewH() + 12);
        const clampScroll = () => { scrollY = Math.max(0, Math.min(maxScroll(), scrollY)); };
        if (ctx.onPageFocus) ctx.onPageFocus(safe('focus', (k) => {
            focus = k; dirty = true;
            const r = k && k.indexOf('ev:') === 0 && rows.find((x) => x.key === k);
            if (r) {   // the controller's row into view
                if (r.y - (r.head ? HEAD : 0) < scrollY + 10) scrollTo = Math.max(0, r.y - (r.head ? HEAD : 0) - 10);
                else if (r.y + ROW > scrollY + viewH() - 20) scrollTo = Math.min(maxScroll(), r.y + ROW - viewH() + 20);
            }
        }));
        if (ctx.onLayout) ctx.onLayout(() => { dirty = true; });
        if (ctx.onBack) ctx.onBack(safe('back', () => { if (tab !== 'past') return false; setTab('live'); return true; }));
        /* "En direct": a tile (or the hero) held or dragged lifts; dropped on another it trades places (dnd). Until it
           lifts the gesture stays the kit's, so a plain tap still picks (a tile) or opens CAM (the hero). */
        const LIFT_MS = 450, LIFT_PX = 20;
        let dnd = null, swapAsk = null;          // the lifted tile; the swap asked (its tiles glow until the new layout)
        const heroBox = () => { const L = st.layout, hr = L && L.heroRect; return hr ? { x: hr.x, y: hr.y + 120, w: hr.w, h: hr.h - 120, i: L.hero, hero: true } : null; };
        // what is under the finger: a pane tile ({i, x, y, w, h, shape}) or the hero (hero: true)
        function under(x, y) {
            const L = st.layout, inR = (r) => r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
            const t = L && L.tiles.find(inR);
            if (t) return t;
            const h = heroBox();
            return inR(h) && Number.isInteger(h.i) ? h : null;
        }
        // tiles trade places within a shape (the server fills each shape's slots in order); anything onto the hero
        const canDrop = (a, b) => !!(a && b && a.i !== b.i && (a.hero || b.hero || a.shape === b.shape));
        function lift() { if (dnd && !dnd.lifted) { dnd.lifted = true; dirty = true; } }
        function dropDnd(x, y) {
            const to = under(x, y);
            if (canDrop(dnd.src, to)) {
                ctl.send({ cmd: 'swap', a: dnd.src.i, b: to.i });
                swapAsk = { a: dnd.src.i, b: to.i, t0: Date.now() };
                log.info('swap ' + dnd.src.i + ' -> ' + to.i);
            }
        }
        function dndTouch(ph, x, y) {
            if (ph === 1) {
                const src = tab === 'live' && overlay() ? under(x, y) : null;
                dnd = src ? { src, x0: x, y0: y, x, y, lifted: false, t: setTimeout(safe('lift', lift), LIFT_MS) } : null;
                return false;                                    // (the kit still sees a tap coming)
            }
            if (!dnd) return false;
            dnd.x = x; dnd.y = y;
            if (!dnd.lifted && Math.abs(x - dnd.x0) + Math.abs(y - dnd.y0) > LIFT_PX) lift();
            if (ph === 3) {
                clearTimeout(dnd.t);
                const was = dnd;
                if (was.lifted) dropDnd(x, y);
                dnd = null; dirty = true;
                return was.lifted;                               // not lifted: the kit's tap
            }
            if (dnd.lifted) dirty = true;
            return dnd.lifted;
        }
        // a finger on the timeline's panel is ours (a drag with inertia, a tap selects its row); on "En direct" dndTouch;
        // anywhere else the kit's
        if (ctx.onTouch) ctx.onTouch(safe('touch', (ph, x, y) => {
            const p = pane();
            if (ph === 1) {
                drag = pastOn() && x >= p.x ? { y0: y, y, t: Date.now(), moved: false, v: 0 } : null;
                if (tab === 'past' && !drag && x >= p.x) log.info('timeline touch ignored: ' + JSON.stringify({ layout: !!st.layout, layer: kIno !== null, pic: st.pic, moving: moving(), shows: showing() }));
                if (drag) { vel = 0; scrollTo = null; dnd = null; return true; }
                return dndTouch(ph, x, y);
            }
            if (!drag) return dndTouch(ph, x, y);
            if (ph === 2) {
                const now = Date.now(), dy = y - drag.y;
                if (Math.abs(y - drag.y0) > 14) drag.moved = true;
                if (drag.moved) { scrollY -= dy; clampScroll(); drag.v = 0.6 * drag.v + 0.4 * (-dy / Math.max(1, now - drag.t)); dirty = true; }
                drag.y = y; drag.t = now;
            } else if (ph === 3) {
                if (drag.moved) vel = Date.now() - drag.t < 100 ? drag.v : 0;      // (a finger held still: no flick)
                else {
                    const r = rows.find((q) => y >= p.y + TOP + q.y - scrollY && y < p.y + TOP + q.y - scrollY + ROW);
                    if (r) playClip(r.e, 'touch'); else log.info('timeline tap on no row at y ' + Math.round(y));
                }
                drag = null; dirty = true;
            }
            return true;
        }));
        settings.onChange(() => { dirty = true; camRec = null; config(); });
        // the view in the decoder now (an older daemon does not say: the one asked)
        const showing = () => (st.shows !== undefined ? st.shows : st.view);
        const overlay = () => !!(st.layout && kIno !== null && st.pic && !moving() && showing() === 'spot');
        // the timeline stays drawn and touchable while the spot's picture is away (a stall, back from a clip): taps
        // on a timeline left on screen did nothing
        const pastOn = () => tab === 'past' && !!st.layout && !moving();
        // the state line over the picture (null: nothing to say)
        function note() {
            if (flash && Date.now() - flash.t < 5000) return flash.s;
            if (!st.up) return 'The RideWatch service is not answering';
            if (moving()) return 'Available only while parked';
            if (st.state === 'error') return st.msg || 'Error';
            if ((st.state === 'connecting' || st.state === 'idle') && !overlay()) return 'Connecting…';
            return null;
        }
        function drawNote(cv, s, x, y, size) {
            const w = cv.textWidth(s, size, LIT) + size * 2;
            cv.roundRect(x - w / 2, y - size * 1.4, w, size * 2.2, size * 1.1, '#000000b0');
            if (s === 'Connecting…') cv.arc(x - w / 2 + size, y - size * 0.3, size * 0.35, size * 0.5, (Date.now() / 3) % 360, (Date.now() / 3) % 360 + 270, '#ffffff');
            cv.text(s, x + (s === 'Connecting…' ? size * 0.4 : 0), y, size, '#ffffff', Object.assign({ align: 'center' }, LIT));
        }
        // text with concept A's shadow (CSS: 0 1px 3px rgba(0,0,0,.8))
        function sh(cv, s, x, y, size, c, o) {
            cv.text(s, x, y + 2, size, '#000000a0', o);
            return cv.text(s, x, y, size, c, o);
        }
        const dot = (cv, x, y, r, c) => { cv.circle(x, y, r * 2.2, (c || DOT) + '30'); cv.circle(x, y, r, c || DOT); };

        // thumbs: a pool of picture ids by event, least recently drawn reused (the YouTube app's)
        const pool = new Map(), free = Array.from({ length: POOL }, (_, i) => POOL0 + i);
        let frameNo = 0;
        function slot(id, th) {
            let e = pool.get(id);
            if (!e) {
                let pid = free.pop();
                if (pid === undefined) {
                    let old = null;
                    pool.forEach((x, k) => { if (x.t < frameNo && (!old || x.t < pool.get(old).t)) old = k; });
                    if (!old) return null;                 // all drawn in this frame already
                    pid = pool.get(old).pid; pool.delete(old);
                }
                pool.set(id, e = { pid, th: null, t: 0 });
            }
            if (e.th !== th) { e.th = th; setImage(e.pid, th.w, th.h, th.buf); }
            e.t = frameNo;
            return e.pid;
        }

        /** concept A over the spot picture; true while something moves (a fade, the halo, the list gliding) */
        function drawSpot(cv, now) {
            const pl = cv.place, s = pl.scale, L = st.layout, kx = pl.w / L.w, ky = pl.h / L.h;
            const T = (x, y, w, h, run, key, r) => cv.target((x - pl.ox) / s, (y - pl.oy) / s, w / s, h / s, run, key, r);
            const hr = L.heroRect ? { x: L.heroRect.x * kx, y: L.heroRect.y * ky, w: L.heroRect.w * kx, h: L.heroRect.h * ky } : { x: 0, y: 0, w: pane().x * kx, h: pl.h };
            // the hero: the daemon's choice at once (the picture follows when the new spot's first frame is in)
            const H0 = st.hero, hero = H0 ? H0.hero : Number.isInteger(L.hero) ? L.hero : null;
            const door = H0 && (H0.why === 'ring' || H0.why === 'person') && H0.event ? H0.event : null;
            let anim = false;
            // the light: a golden wash from the top, or a ring round the subject at the door (3 pulses, then steady)
            if (door) {
                const age = now - heroT, k = age < 3600 ? 0.6 + 0.4 * Math.cos(age / 600 * Math.PI) : 0.6;
                if (age < 3600) anim = true;
                const b = { x: hr.x + hr.w * 0.289, y: hr.y, w: hr.w * 0.422, h: hr.h };
                [[44, 0.07], [28, 0.1], [16, 0.16], [8, 0.24], [3, 0.9]].forEach((q) => cv.strokeRoundRect(b.x, b.y + 2, b.w, b.h - 4, 22, q[0], GOLD + hexA(q[1] * k)));
            } else cv.gradientRect(hr.x, hr.y, hr.w, hr.h / 2, [[0, '#F0C06824'], [1, '#F0C06800']]);
            cv.gradientRect(hr.x, hr.y, hr.w, 150, [[0, '#000000a0'], [1, '#00000000']]);
            cv.gradientRect(hr.x, hr.y + hr.h - 200, hr.w, 200, [[0, '#00000000'], [1, '#000000c7']]);
            // the tabs (top left)
            let tx = hr.x + 36;
            const tabs = [];
            [['live', 'Live'], ['past', 'What happened']].forEach((q) => {
                const on = tab === q[0], w = cv.textWidth(q[1], 26, BOLD);
                sh(cv, q[1], tx, 62, 26, on ? '#ffffff' : '#ffffffa8', BOLD);
                if (on) cv.roundRect(tx, 74, w, 3, 1.5, GOLD);
                tabs.push([tx - 14, 24, w + 28, 64, () => setTab(q[0]), 'tab:' + q[0], 10]);
                tx += w + 44;
            });
            const tabTargets = () => tabs.forEach((a) => T.apply(null, a));   // last in the knob's order
            // the clock and the context (top right of the hero)
            const right = hr.x + hr.w - 40;
            sh(cv, hhmm(now), right, 66, 40, '#ffffff', Object.assign({ align: 'right' }, BOLD));
            const where = H0 && H0.home === true ? ' · car at home' : H0 && H0.home === false ? ' · car away' : '';
            if (H0) sh(cv, (H0.night ? 'Night' : 'Day') + where, right, 104, 24, SUB, Object.assign({ align: 'right' }, LIT));
            // the hero: a target (press = that camera alone), its name and what happened there (fading in on a change)
            if (hero !== null) {
                T(hr.x, hr.y + 120, hr.w, hr.h - 120, () => open(hero), 'hero', 0);
                const a = Math.min(1, (now - heroT) / 400);
                if (a < 1) { anim = true; cv.alpha(a); }
                if (door) {
                    dot(cv, hr.x + 50, hr.y + hr.h - 146, 8);
                    sh(cv, TYPE[door.type] + ' · ' + name(hero), hr.x + 72, hr.y + hr.h - 130, 48, '#ffffff', BOLD);
                    sh(cv, rel(door.ts, now) + (door.type === 'person' ? ' · doorbell not pressed' : ''), hr.x + 40, hr.y + hr.h - 64, 28, SUB, LIT);
                } else {
                    sh(cv, name(hero), hr.x + 40, hr.y + hr.h - 116, 46, '#ffffff', BOLD);
                    const e = H0 && H0.event && H0.event.cam === hero ? H0.event : lastOf(hero);
                    if (e) {
                        const recent = now - e.ts < RECENT_MS;
                        if (recent) dot(cv, hr.x + 47, hr.y + hr.h - 65, 6);
                        sh(cv, TYPE[e.type] + ' · ' + (now - e.ts < 3600000 ? hhmm(e.ts) + ' · ' : '') + rel(e.ts, now), hr.x + (recent ? 64 : 40), hr.y + hr.h - 56, 28, SUB, LIT);
                    } else sh(cv, 'Live', hr.x + 40, hr.y + hr.h - 56, 28, SUB, LIT);
                }
                if (a < 1) cv.alpha(1);
            }
            // a live event: a golden banner over the hero for 6 s (in over 0.3 s, out over the last second)
            if (banner) {
                const age = now - banner.t0;
                if (age > 6000) banner = null;
                else {
                    anim = true;
                    const a = Math.min(1, age / 300, (6000 - age) / 1000), s1 = TYPE[banner.e.type] + ' · ' + name(banner.e.cam), w = cv.textWidth(s1, 26, BOLD) + 76;
                    const bx = hr.x + hr.w / 2 - w / 2;
                    cv.alpha(a);
                    cv.roundRect(bx, 120, w, 52, 26, '#1a1408d8');
                    cv.strokeRoundRect(bx, 120, w, 52, 26, 2, GOLD + 'c0');
                    dot(cv, bx + 30, 146, 7);
                    cv.text(s1, bx + 50, 155, 26, '#ffffff', BOLD);
                    cv.alpha(1);
                }
            }
            if (tab === 'past') { const g = drawTimeline(cv, now, T); tabTargets(); return g || anim; }
            // the pane: a target and a label per tile, as the server placed them; the gold dot for a recent event
            L.tiles.forEach((t) => {
                const x = t.x * kx, y = t.y * ky, w = t.w * kx, h = t.h * ky, label = t.label || name(t.i), round = t.shape === 'round';
                T(x, y, w, h, () => pick(t.i), 'cam:' + t.i, round ? w / 2 : 6);
                if (focus === 'cam:' + t.i) cv.strokeRoundRect(x - 3, y - 3, w + 6, h + 6, round ? w / 2 + 3 : 9, 6, GOLD + '50');   // the glow round the kit's ring
                if (round) { sh(cv, label, x + w / 2, y + h - 30, 20, '#ffffff', Object.assign({ align: 'center' }, BOLD)); return; }
                const size = t.shape === 'tall' ? 20 : 24, e = t.shape === 'tall' ? null : lastOf(t.i), gh = Math.min(h, size * 3.4);
                cv.gradientRect(x, y + h - gh, w, gh, [[0, '#00000000'], [1, '#000000c7']]);
                sh(cv, label, x + 14, y + h - size * (e ? 1.75 : 0.65), size, '#ffffff', BOLD);
                if (e) {
                    const recent = now - e.ts < RECENT_MS;
                    if (recent) dot(cv, x + 19, y + h - size * 0.62 - 6, 4.5);
                    sh(cv, TYPE[e.type] + ' ' + (dayOf(e.ts) === dayOf(now) ? hhmm(e.ts) : rel(e.ts, now)), x + (recent ? 32 : 14), y + h - size * 0.35, size * 0.85, SUB, LIT);
                }
            });
            tabTargets();
            return drawDnd(cv, now, kx, ky) || anim;
        }

        /** the lifted tile: its place dimmed, the drop target ringed in gold, a live ghost of it under the finger;
         *  after a drop the two tiles glow until the server's new layout (or 4 s); true while something shows */
        function drawDnd(cv, now, kx, ky) {
            const R = (r) => ({ x: r.x * kx, y: r.y * ky, w: r.w * kx, h: r.h * ky, r: r.shape === 'round' ? r.w * kx / 2 : r.hero ? 0 : 6 });
            const ring = (r, a) => [[18, 0.12], [10, 0.22], [4, 0.95]].forEach((q) => cv.strokeRoundRect(r.x - q[0] / 2, r.y - q[0] / 2, r.w + q[0], r.h + q[0], r.r + q[0] / 2, q[0], GOLD + hexA(q[1] * a)));
            if (swapAsk && now - swapAsk.t0 > 4000) swapAsk = null;
            if (swapAsk) {
                const a = 0.55 + 0.45 * Math.cos((now - swapAsk.t0) / 250 * Math.PI);
                [swapAsk.a, swapAsk.b].forEach((i) => { const t = st.layout.tiles.find((q) => q.i === i) || (i === st.layout.hero ? heroBox() : null); if (t) ring(R(t), a); });
            }
            if (!dnd || !dnd.lifted) return !!swapAsk;
            const s = R(dnd.src), to = under(dnd.x, dnd.y);
            cv.roundRect(s.x, s.y, s.w, s.h, s.r, '#000000b0');
            cv.strokeRoundRect(s.x + 1, s.y + 1, s.w - 2, s.h - 2, s.r, 2, '#ffffff70');
            if (canDrop(dnd.src, to)) {
                const t = R(to);
                ring(t, 1);
                if (to.hero) {
                    const msg = 'Show big', w = cv.textWidth(msg, 28, BOLD) + 60;
                    cv.roundRect(t.x + t.w / 2 - w / 2, t.y + t.h / 2 - 36, w, 64, 32, '#1a1408e0');
                    cv.text(msg, t.x + t.w / 2, t.y + t.h / 2 + 8, 28, '#ffffff', Object.assign({ align: 'center' }, BOLD));
                }
            }
            // the ghost: the tile's own live picture (the frame drawn shifted and scaled under a clip), 10 % bigger
            const k = dnd.src.hero ? 360 / s.w : 1.1, gw = s.w * k, gh = s.h * k, gx = dnd.x - gw / 2, gy = dnd.y - gh / 2;
            cv.roundRect(gx + 6, gy + 10, gw, gh, s.r * k, '#00000080');
            cv.clip(gx, gy, gw, gh);
            cv.video(VID, gx - s.x * k, gy - s.y * k, cv.place.w * k, cv.place.h * k, 0);
            cv.noclip();
            cv.strokeRoundRect(gx, gy, gw, gh, s.r * k, 3, GOLD);
            const label = dnd.src.hero ? name(dnd.src.i) : dnd.src.label || name(dnd.src.i);
            sh(cv, label, gx + gw / 2, gy + gh + 30, 22, '#ffffff', Object.assign({ align: 'center' }, BOLD));
            return true;
        }

        /** "What happened": the panel over the pane; true while the list glides */
        function drawTimeline(cv, now, T) {
            const p = pane(), x0 = p.x, pw = p.w;
            const list = st.events.filter((e) => TIMELINE.indexOf(e.type) >= 0).slice().reverse();
            // the rows' places in the list (px from its top), a day header before each day's first
            rows = [];
            let y = 0, day = null;
            list.forEach((e) => {
                const d = dayOf(e.ts), head = d !== day ? dayName(e.ts, now) : null;
                if (head) { y += HEAD; day = d; }
                rows.push({ key: 'ev:' + e.id, e, y, head });
                y += ROW;
            });
            listH = y;
            // gliding: to the controller's row, or a flick's inertia
            let glide = false;
            const dt = Math.min(50, now - frameT);
            frameT = now;
            if (scrollTo !== null) { scrollY += (scrollTo - scrollY) * 0.3; if (Math.abs(scrollTo - scrollY) < 1) { scrollY = scrollTo; scrollTo = null; } else glide = true; }
            if (vel && !drag) {
                scrollY += vel * dt; vel *= Math.pow(0.996, dt);
                const was = scrollY;
                clampScroll();
                if (Math.abs(vel) < 0.03 || was !== scrollY) vel = 0; else glide = true;
            }
            clampScroll();
            cv.fillRect(x0, p.y, pw, p.h, '#0b0b0edb');
            cv.fillRect(x0, p.y, 2, p.h, '#ffffff18');
            if (!list.length) cv.text('Nothing to see yet', x0 + pw / 2, p.y + p.h / 2, 24, DIM, Object.assign({ align: 'center' }, LIT));
            const top = p.y + TOP;
            rows.forEach((r) => {
                const ry = top + r.y - scrollY;
                T(x0 + 10, ry, pw - 36, ROW - 12, () => playClip(r.e), r.key, 12);       // every row: the knob reaches them all
                if (r.head && ry > 0 && ry - HEAD < p.y + p.h) cv.text(r.head, x0 + 24, ry - 18, 22, DIM, BOLD);
                if (ry + ROW < p.y || ry > p.y + p.h) return;
                const e = r.e, recent = now - e.ts < RECENT_MS, tx = x0 + 204;
                if (sel === e.id) { cv.roundRect(x0 + 10, ry, pw - 36, ROW - 12, 12, '#F0C06828'); cv.roundRect(x0 + 10, ry + 12, 4, ROW - 36, 2, GOLD); }
                else if (focus === r.key) cv.roundRect(x0 + 10, ry, pw - 36, ROW - 12, 12, '#ffffff14');
                const th = thumbs[e.id], pid = th ? slot(e.id, th) : null;
                if (pid !== null) cv.picture(pid, x0 + 24, ry + 6, 160, 90, 8);
                else { cv.roundRect(x0 + 24, ry + 6, 160, 90, 8, '#ffffff14'); wantThumb(e); }
                cv.text(name(e.cam), tx, ry + 34, 26, '#ffffff', BOLD);
                if (recent) dot(cv, tx + 6, ry + 57, 5);
                cv.text(TYPE[e.type] + (e.count > 1 ? ' · ×' + e.count : ''), tx + (recent ? 20 : 0), ry + 65, 22, SUB, LIT);
                cv.text(rel(e.ts, now), tx, ry + 93, 20, DIM, LIT);
            });
            // the scroll bar on the panel's right edge: where the list is, and how much of it shows
            if (listH > viewH()) {
                const tr = { x: x0 + pw - 12, y: p.y + 12, h: p.h - 24 }, max = maxScroll();
                const bh = Math.max(40, tr.h * viewH() / listH), by = tr.y + (tr.h - bh) * (max ? scrollY / max : 0);
                cv.roundRect(tr.x, tr.y, 4, tr.h, 2, '#ffffff1c');
                cv.roundRect(tr.x - 1, by, 6, bh, 3, GOLD);
            }
            return glide;
        }

        function drawView(cv) {
            const pl = cv.place, now = Date.now();
            frameNo++;
            cv.xf(1, 0, 0).fillRect(0, 0, pl.w, pl.h, '#000000');
            const v0 = showing(), v = v0 === 'clip' ? clipCam : v0, L = st.layout;   // (back from a clip: its camera's frame)
            if (kIno !== null && Number.isInteger(v) && L && L.heroRect) {
                // back from CAM: that camera's stream still plays until the spot's own picture is in: in the hero's place
                const hr = L.heroRect, k = pl.w / L.w, fr = frameSize();
                const r = F.place(F.picRect(camW(v), camH(v), fr.w, fr.h), fr.w, fr.h, { x: hr.x * k, y: hr.y * k, w: hr.w * k, h: hr.h * k }, 'whole', null);
                cv.clip(r.pic.x, r.pic.y, r.pic.w, r.pic.h).video(VID, r.frame.x, r.frame.y, r.frame.w, r.frame.h, 0).noclip();
            } else if (kIno !== null) cv.video(VID, 0, 0, pl.w, pl.h, 0);
            let anim = false;
            if (overlay() || pastOn()) anim = drawSpot(cv, now);
            else { rows = []; frameT = now; }
            const n = note();
            if (n) drawNote(cv, n, pl.w / 2, pl.h / 2, 30);
            cv.xf();
            return anim;
        }
        let anim = false;
        function render() {
            const now = Date.now();
            // redraw on a change and every frame while something moves, else 4 times a second (clock, spinner, "il y a")
            if (!last || dirty || anim || drag || now - lastT > 250) {
                dirty = false; lastT = now;
                const cv = ctx.canvas(W, H);
                if (cv.own && cv.place) anim = drawView(cv);
                else {
                    cv.clear('#000000');
                    cv.text('RideWatch needs the GPU renderer (mgu-render)', W / 2, H / 2, 30, '#ffffff', Object.assign({ align: 'center' }, LIT));
                }
                last = cv;
            }
            return ui.image('VIEW_GFX', last);
        }
        ctx.loop('VIEW', 10, render);

        /* ---------- CAM: one camera, the app's own layer ---------- */
        const gpu = new RenderClient(ctx.spec.id, log, { kit: record });
        let camShown = false, cIno = null, camRec = null, lastMsg = 0, ccuLast = null;
        gpu.on('ready', safe('gpu ready', (screen, info) => {
            if (!info) return;                                  // not mgu-render/1: no video here
            gpu.mode('layer');
            gpu.place({ x: 0, y: 0, w: screen.w, h: screen.h, scale: 1, ox: 0, oy: 0 });
            gpu.claim([{ x: 0, y: 0, w: screen.w, h: screen.h }]);
            cIno = null; camRec = null;                         // the renderer forgot our video with the connection
            sync();
        }));
        gpu.on('close', safe('gpu close', () => { cIno = null; }));
        gpu.connect();
        /* CAM's picture: where the camera is in the stream now playing (null: another camera's, still there) */
        let camPan = { x: 0, y: 0 }, camRange = { x: 0, y: 0 }, wakeT = Date.now(), tch = null;
        const camMode = {};                      // camera -> 'fill' | 'whole' (until the app restarts)
        const CHIP = { w: 330, h: 76 }, FADE_MS = 4000;
        function srcOf(v) {
            const L = st.layout, fr = frameSize();
            if (v === 'spot' && L && L.heroRect) return { cam: L.hero, src: L.heroRect, fw: L.w, fh: L.h };
            if (Number.isInteger(v)) return { cam: v, src: F.picRect(camW(v), camH(v), fr.w, fr.h), fw: fr.w, fh: fr.h };
            if (v === 'clip') return { cam: 'clip', src: F.picRect(camW(clipCam), camH(clipCam), fr.w, fr.h), fw: fr.w, fh: fr.h };   // fitted as a `cam` view
            return null;
        }
        const viaSpot = (i) => { const s = srcOf(showing()); return showing() === 'spot' && !!s && s.cam === i; };
        const modeOf = (i, s, box) => camMode[i] || F.defaultMode(s.src, box);
        function wake() { wakeT = Date.now(); camRec = null; }
        const chipAt = (pl) => ({ x: pl.w - CHIP.w - 36, y: pl.h - CHIP.h - 32, w: CHIP.w, h: CHIP.h });
        // a clip's end: "Replay" and "Live", side by side bottom centre
        const clipBtns = (pl) => [['Replay', replay], ['Live', direct]].map((q, k) => ({ x: pl.w / 2 + (k ? 12 : -272), y: pl.h - 108, w: 260, h: 76, label: q[0], run: q[1] }));
        const hit = (c, x, y) => x >= c.x - 20 && x < c.x + c.w + 20 && y >= c.y - 20 && y < c.y + c.h + 20;
        function toggleMode() {
            const s = srcOf(viaSpot(cam) ? 'spot' : cam), pl = gpu.placement;
            if (!s || !pl) return;
            camMode[cam] = modeOf(cam, s, { x: 0, y: 0, w: pl.w, h: pl.h }) === 'fill' ? 'whole' : 'fill';
            camPan = { x: 0, y: 0 }; wake();
        }
        function panBy(dx, dy) { camPan = { x: camPan.x + dx, y: camPan.y + dy }; wake(); camFrame(); }
        function camFrame() {
            const pl = gpu.placement;
            if (!pl) return;
            const now = Date.now();
            if (!camRec) {
                // a clip: the decoder's picture is the clip's from its first frame on (also while "Revoir" connects)
                const box = { x: 0, y: 0, w: pl.w, h: pl.h }, v0 = showing(), s = srcOf(clip && (v0 === null || v0 === 'clip') ? 'clip' : v0);
                const mine = !!s && st.pic && (clip ? v0 === 'clip' : s.cam === cam);
                camRec = new Recorder(pl.w, pl.h).clear(0x000000ff);
                if (cIno !== null && s) {
                    // the camera's picture placed (fill / whole, panned); the camera before stays, dimmed, while this one connects
                    const r = F.place(s.src, s.fw, s.fh, box, mine ? modeOf(cam, s, box) : 'fill', mine ? camPan : null);
                    if (mine) { camPan = r.pan; camRange = r.range; }
                    camRec.clip(r.pic.x, r.pic.y, r.pic.w, r.pic.h).video(VID, r.frame.x, r.frame.y, r.frame.w, r.frame.h, 0).noclip();
                    if (!mine) camRec.fillRect(0, 0, pl.w, pl.h, '#000000a0');
                }
                // the overlay (name, live dot, clock, the mode chip, where the pan is): full for 4 s after a touch, then fades
                const age = now - wakeT, a = mine && !clip ? Math.max(0, Math.min(1, 1 - (age - FADE_MS) / 600)) : 1;
                camRec.fade = clip ? !!clip.info && !clip.ended : mine && a > 0;   // (until it is gone / the clip's bar: the 50 ms timer redraws)
                if (a > 0) {
                    camRec.alpha(a);
                    camRec.gradientRect(0, 0, pl.w, 140, [[0, '#000000a0'], [1, '#00000000']]);
                    if (clip) {
                        // what, where, when; the bar: how much has played
                        const e = clip.e;
                        sh(camRec, TYPE[e.type] + ' · ' + name(e.cam) + ' · ' + hhmm(e.first || e.ts), 40, 68, 40, '#ffffff', BOLD);
                        if (clip.info) {
                            const k = clip.ended ? 1 : Math.min(1, (now - clip.t0) / clip.info.dur);
                            camRec.roundRect(40, 96, pl.w - 80, 6, 3, '#ffffff30').roundRect(40, 96, Math.max(6, (pl.w - 80) * k), 6, 3, GOLD);
                        }
                        if (clip.ended) clipBtns(pl).forEach((b, k) => {
                            camRec.roundRect(b.x, b.y, b.w, b.h, b.h / 2, '#000000b8');
                            camRec.strokeRoundRect(b.x, b.y, b.w, b.h, b.h / 2, clipSel === k ? 3 : 2, clipSel === k ? GOLD : '#ffffff40');
                            camRec.text(b.label, b.x + b.w / 2, b.y + b.h / 2 + 10, 28, '#ffffff', Object.assign({ align: 'center' }, BOLD));
                        });
                    } else if (cam !== null) {
                        if (mine) { camRec.circle(52, 54, 16, '#E5484D30'); camRec.circle(52, 54, 8, '#E5484D'); }
                        sh(camRec, name(cam), mine ? 76 : 40, 68, 40, '#ffffff', BOLD);
                    }
                    if (!clip) sh(camRec, hhmm(now), pl.w - 40, 68, 36, '#ffffff', Object.assign({ align: 'right' }, BOLD));
                    const c = chipAt(pl), whole = mine && modeOf(cam, s, box) === 'whole';
                    if (mine && !clip) {
                        camRec.roundRect(c.x, c.y, c.w, c.h, c.h / 2, '#000000b8');
                        camRec.strokeRoundRect(c.x, c.y, c.w, c.h, c.h / 2, 2, '#ffffff40');
                        camRec.text(whole ? 'Fill the screen' : 'Whole picture', c.x + c.w / 2, c.y + c.h / 2 + 10, 28, '#ffffff', Object.assign({ align: 'center' }, BOLD));
                    }
                    if (mine && camRange.y > 0) {          // the pan bar: how much is hidden above and below
                        const tr = { x: pl.w - 14, y: 160, h: pl.h - 320 }, k = pl.h / (pl.h + 2 * camRange.y);
                        const bh = tr.h * k, by = tr.y + (tr.h - bh) * (camRange.y - camPan.y) / (2 * camRange.y);
                        camRec.roundRect(tr.x, tr.y, 5, tr.h, 2.5, '#ffffff30').roundRect(tr.x - 1, by, 7, bh, 3.5, GOLD);
                    }
                    camRec.alpha(1);
                }
                const n = note() || (!mine ? 'Connecting…' : null);
                if (n) drawNote(camRec, n, pl.w / 2, pl.h / 2, 30);
                if (n === 'Connecting…') camRec.spin = true;        // (redrawn for the spinner)
            }
            gpu.frame(camRec);
            lastMsg = now;
            if (camRec.spin || camRec.fade) camRec = null;
        }
        // the overlay's fade and the spinner: 20 frames a second while they move (the 250 ms sync is too slow for them)
        setInterval(safe('cam anim', () => { if (camShown && !camRec) camFrame(); }), 50);
        // a finger: a drag pans (fill), a tap on the chip toggles fill / whole, any other tap: back to the spot
        gpu.on('touch', safe('touch', (ph, x, y) => {
            if (!camShown) return;
            if (ph === 'down') { tch = { x, y, pan: { x: camPan.x, y: camPan.y }, moved: false }; return; }
            if (!tch) return;
            if (ph === 'move') {
                if (Math.abs(x - tch.x) > 14 || Math.abs(y - tch.y) > 14) tch.moved = true;
                if (tch.moved && (camRange.x || camRange.y)) { camPan = { x: tch.pan.x + x - tch.x, y: tch.pan.y + y - tch.y }; wake(); camFrame(); }
                return;
            }
            if (ph === 'up') {
                const pl = gpu.placement || { w: 1920, h: 720 }, c = chipAt(pl), t = tch;
                tch = null;
                if (t.moved) return;
                const b = clip && clip.ended ? clipBtns(pl).find((q) => hit(q, x, y)) : null;
                if (b) b.run();
                else if (!clip && hit(c, x, y)) toggleMode();
                else back();
            }
        }));
        // the controller (the renderer's copy while grabbed): turn = next / previous camera, press or push left = back,
        // up / down = pan a third of the screen, right = fill / whole
        gpu.on('ccu', safe('ccu', (v) => {
            const L = ccuLast;
            ccuLast = v;
            if (!camShown || !L || (v.press === 15 && v.tilt === 15)) return;   // (15: no controller behind it)
            const d = ((v.knob - L.knob + 32768) & 0xffff) - 32768;
            // a clip: the turn picks "Revoir" / "Direct" once it ended, the press runs it
            if (d && Math.abs(d) <= 64) { if (!clip) turn(d > 0 ? 1 : -1); else if (clip.ended) { clipSel = d > 0 ? 1 : 0; camRec = null; } }
            const down = (p) => p === 1 || p === 2, tilt = (a, b) => (v.tilt === a || v.tilt === b) && L.tilt !== v.tilt;
            if (down(v.press) && !down(L.press)) { if (clip && clip.ended) clipBtns(gpu.placement || { w: 1920, h: 720 })[clipSel].run(); else back(); }
            if (tilt(10, 11)) back();
            if (tilt(1, 2)) panBy(0, (gpu.placement ? gpu.placement.h : 720) / 3);
            if (tilt(7, 8)) panBy(0, -(gpu.placement ? gpu.placement.h : 720) / 3);
            if (tilt(4, 5)) toggleMode();
        }));

        /* ---------- the stream and the video gates (every 250 ms) ---------- */
        const ino = () => { try { const f = fs.statSync(VPATH); return f.isFile() ? f.ino : null; } catch (e) { return null; } };
        function sync() {
            const vView = shown('VIEW'), vCam = shown('CAM') && cam !== null, mv = moving();
            // CAM of the spot's hero: the spot already playing (no new stream); any other camera: its own stream
            const want = st.up && !mv ? (vCam ? (clip ? 'clip' : viaSpot(cam) ? 'spot' : cam) : vView ? 'spot' : null) : null;
            if (want !== null) {
                const r = rect(), k = want + ' ' + r + (want === 'clip' ? ' ' + clip.e.id + ' #' + clip.n : '');   // (#n: "Revoir" asks again)
                if (k !== sent) { ctl.send(want === 'clip' ? { cmd: 'view', view: 'clip', id: clip.e.id, rect: r } : { cmd: 'view', view: want, rect: r }); sent = k; log.info('view ' + k); }
            } else if (sent !== null && sent !== 'stop' && st.up) {
                ctl.send({ cmd: 'stop', why: mv ? 'moving' : 'hidden' }); sent = 'stop';
                if (!mv) { sel = null; tab = 'live'; }            // left the app: the pick goes too (driving off keeps it)
                log.info('stop (' + (mv ? 'moving' : 'hidden') + ')');
            }
            // the decoder's file: on VIEW through the kit's renderer, on CAM through ours (a new file is named again)
            const pic = st.pic && want !== null;
            const kCur = pic && vView ? ino() : null, g = kgpu();
            if (g) { if (!kCur || kCur !== kIno) g.dropVideo(VID); if (kCur) g.video(VID, VPATH); }
            if (kCur !== kIno) { kIno = g ? kCur : null; dirty = true; }
            const cWant = vCam && !!gpu.placement, cCur = cWant && pic ? ino() : null;
            if (cCur !== cIno) {
                if (cIno !== null) gpu.video(VID, null);
                if (cCur !== null) gpu.video(VID, VPATH);
                cIno = cCur; camRec = null;
            }
            if (cWant !== camShown) {
                camShown = cWant;
                ccuLast = null;
                gpu.grab(cWant);
                gpu.show(cWant);
                camRec = null;
                log.info('camera layer ' + (cWant ? 'shown' : 'hidden'));
            }
            if (camShown && (Date.now() - lastMsg >= KEEPALIVE_MS || !camRec)) camFrame();
        }
        setInterval(safe('sync', sync), 250);
        ui.onVisible(safe('visible', (n, on) => { if (n === 'CAM' && !on) clip = null; dirty = true; camRec = null; sync(); }));   // (left CAM: the clip is done)
        if (ui.onFocus) ui.onFocus(safe('focus', () => sync()));
        log.info('ridewatch app started');
    },
});
