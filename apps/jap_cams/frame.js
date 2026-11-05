'use strict';
/**
 * frame.js - where a camera's picture is in the stream and where it goes on the screen (pure: test/frame_test.js).
 * CAM draws the stream's frame (1920x720, the same size as every view: camdec never reopens its file) scaled and
 * shifted so that the camera's picture fills the screen (cropped, panned by a finger) or shows whole; the renderer
 * clips what falls off the screen. The source is a `cam i WxH` stream (the picture fitted, with black bars:
 * serve.py fit()) or the spot stream's hero (the same camera at the same 1280x720, already playing: no new stream).
 */
const FILL_MAX_CROP = 0.15;              // serve.py fit(): it crops itself when that cuts at most 15 %
const FILL_DEFAULT = 0.4;                // a picture fills the screen at first when that hides at most 40 % (16:9: 33 %)

const even = (v) => Math.max(2, Math.floor(v / 2) * 2);

/** The camera's picture inside a `cam` stream of fw x fh (cw x ch: its size from the list; unknown: 16:9). */
function picRect(cw, ch, fw, fh) {
    if (!(cw > 0 && ch > 0)) { cw = 16; ch = 9; }
    const cover = Math.max(fw / cw, fh / ch);
    if (1 - (fw * fh) / (cw * cover * ch * cover) <= FILL_MAX_CROP) return { x: 0, y: 0, w: fw, h: fh };
    const s = Math.min(fw / cw, fh / ch), w = Math.min(fw, even(cw * s)), h = Math.min(fh, even(ch * s));
    return { x: Math.floor((fw - w) / 2), y: Math.floor((fh - h) / 2), w, h };
}

/** 'fill' when filling `box` with the picture `src` hides at most 40 % of it, else 'whole'. */
function defaultMode(src, box) {
    const k = Math.max(box.w / src.w, box.h / src.h);
    return 1 - (box.w * box.h) / (src.w * k * src.h * k) <= FILL_DEFAULT ? 'fill' : 'whole';
}

/**
 * The picture src (in the frame's px, the frame fw x fh) into box: 'fill' covers it, 'whole' fits in it. pan
 * {x, y}: px from centred (clamped to what the crop hides). Returns the frame's rect to draw the video in (its aspect:
 * the renderer draws it 1:1 there), the picture's rect on the screen (to clip to), the pan kept and its range.
 */
function place(src, fw, fh, box, mode, pan) {
    const k = mode === 'fill' ? Math.max(box.w / src.w, box.h / src.h) : Math.min(box.w / src.w, box.h / src.h);
    const pw = src.w * k, ph = src.h * k, rx = Math.max(0, (pw - box.w) / 2), ry = Math.max(0, (ph - box.h) / 2);
    const p = { x: Math.max(-rx, Math.min(rx, (pan && pan.x) || 0)), y: Math.max(-ry, Math.min(ry, (pan && pan.y) || 0)) };
    const x = box.x + (box.w - pw) / 2 + p.x, y = box.y + (box.h - ph) / 2 + p.y;
    return { frame: { x: x - src.x * k, y: y - src.y * k, w: fw * k, h: fh * k }, pic: { x, y, w: pw, h: ph }, pan: p, range: { x: rx, y: ry } };
}

module.exports = { picRect, defaultMode, place };
