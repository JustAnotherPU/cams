#!/usr/bin/env node
'use strict';
// A stand-in for camdec (native/camdec/README.md): reads Annex-B on stdin, prints the stdout JSON contract
// (ready per SPS + IDR, stats, eof) and logs each NAL it got to $FAKE_CAMDEC_LOG as "<type> <tag> <seq> ok|BAD"
// (the fake server's NALs carry their own length: a cut one is BAD). Exit 0 on stdin EOF, 2 without --out.
const fs = require('fs');
const out = process.argv.indexOf('--out');
if (out < 0 || !process.argv[out + 1]) process.exit(2);
const LOG = process.env.FAKE_CAMDEC_LOG;
const note = (s) => { if (LOG) fs.appendFileSync(LOG, process.pid + ' ' + s + '\n'); };
const say = (o) => process.stdout.write(JSON.stringify(o) + '\n');
note('start');
let buf = Buffer.alloc(0), sps = false, decoded = 0;
function nal(b) {
    let e = b.length;
    while (e > 0 && b[e - 1] === 0) e--;                    // trailing zero (the next 4-byte start code's)
    b = b.slice(0, e);
    const type = b[0] & 0x1f, m = /^(\w+),(\d+),(\d+)\./.exec(b.slice(1).toString('latin1'));
    note(type + ' ' + (m ? m[1] + ' ' + m[2] + ' ' + (+m[3] === b.length ? 'ok' : 'BAD') : '- - BAD'));
    if (type === 7) sps = true;
    if (type === 5 && sps) { sps = false; say({ ev: 'ready', w: 1920, h: 720, fps: 30 }); }
    if (type === 5 || type === 1) decoded++;
}
function scan(final) {
    const at = [];
    for (let i = 0; i + 2 < buf.length; i++) if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) at.push(i);
    if (!at.length) return;
    for (let k = 0; k + 1 < at.length; k++) nal(buf.slice(at[k] + 3, at[k + 1]));
    if (final) { nal(buf.slice(at[at.length - 1] + 3)); buf = Buffer.alloc(0); } else buf = buf.slice(at[at.length - 1]);
}
process.stdin.on('data', (d) => { buf = Buffer.concat([buf, d]); scan(false); });
process.stdin.on('end', () => { scan(true); note('eof'); say({ ev: 'eof' }); process.exit(0); });
setInterval(() => say({ ev: 'stats', decoded, shown: decoded, dropped: 0, queue: 1, decode_ms: 2.5, cpu_pct: 7, fps: 30 }),
    +process.env.FAKE_STATS_MS || 2000);
