'use strict';
// frame.js: the picture in a cam stream (as serve.py fit() places it) and the fill / whole / pan maths.
//   node test/frame_test.js
const assert = require('assert');
const { picRect, defaultMode, place } = require('../../apps/jap_cams/frame');

const S = { x: 0, y: 0, w: 1920, h: 720 };
// serve.py fit(): 16:9 into 8:3 pads (crop 33 %), the 3:4 door 540x720, a square 720x720, unknown = 16:9
assert.deepStrictEqual(picRect(1280, 720, 1920, 720), { x: 320, y: 0, w: 1280, h: 720 });
assert.deepStrictEqual(picRect(3840, 2160, 1920, 720), { x: 320, y: 0, w: 1280, h: 720 });
assert.deepStrictEqual(picRect(1440, 1920, 1920, 720), { x: 690, y: 0, w: 540, h: 720 });
assert.deepStrictEqual(picRect(1280, 1280, 1920, 720), { x: 600, y: 0, w: 720, h: 720 });
assert.deepStrictEqual(picRect(null, null, 1920, 720), { x: 320, y: 0, w: 1280, h: 720 });
assert.deepStrictEqual(picRect(2400, 1000, 1920, 720), S, 'crop <= 15 %: the server fills itself');

const wide = picRect(1280, 720, 1920, 720), door = picRect(1440, 1920, 1920, 720);
assert.strictEqual(defaultMode(wide, S), 'fill');
assert.strictEqual(defaultMode(door, S), 'whole');
assert.strictEqual(defaultMode({ x: 0, y: 0, w: 720, h: 720 }, S), 'whole');

// fill, centred: the picture 1920x1080 at y -180, the frame 2880x1080 at x -480 (its pillar bars off screen)
let p = place(wide, 1920, 720, S, 'fill', null);
assert.deepStrictEqual(p.frame, { x: -480, y: -180, w: 2880, h: 1080 });
assert.deepStrictEqual([p.pic, p.range], [{ x: 0, y: -180, w: 1920, h: 1080 }, { x: 0, y: 180 }]);
// pan: clamped to what the crop hides (180 px up or down, nothing sideways)
p = place(wide, 1920, 720, S, 'fill', { x: 50, y: 500 });
assert.deepStrictEqual([p.pan, p.frame.y, p.frame.x], [{ x: 0, y: 180 }, 0, -480]);
p = place(wide, 1920, 720, S, 'fill', { y: -999 });
assert.deepStrictEqual([p.pan.y, p.pic.y + p.pic.h], [-180, 720], 'the bottom edge at the screen\'s bottom');
// whole: the cam stream as it is (1:1)
assert.deepStrictEqual(place(wide, 1920, 720, S, 'whole', { y: 99 }).frame, { x: 0, y: 0, w: 1920, h: 720 });
// the spot's hero (1280x720 at 0,0 in the spot frame) on the whole screen: fill = the frame at 1.5x, its pane off screen
const hero = { x: 0, y: 0, w: 1280, h: 720 };
assert.deepStrictEqual(place(hero, 1920, 720, S, 'fill', null).frame, { x: 0, y: -180, w: 2880, h: 1080 });
assert.deepStrictEqual(place(hero, 1920, 720, S, 'whole', null), { frame: { x: 320, y: 0, w: 1920, h: 720 }, pic: { x: 320, y: 0, w: 1280, h: 720 }, pan: { x: 0, y: 0 }, range: { x: 0, y: 0 } });
// the door filling the screen: 3.56x, a long way to pan
p = place(door, 1920, 720, S, 'fill', null);
assert.ok(Math.abs(p.range.y - (2560 - 720) / 2) < 1e-6 && p.range.x === 0);
// a cam picture into VIEW's hero rect (back from CAM, the spot not there yet)
assert.deepStrictEqual(place(wide, 1920, 720, hero, 'whole', null).frame, { x: -320, y: 0, w: 1920, h: 720 });
console.log('frame_test: all checks passed');
