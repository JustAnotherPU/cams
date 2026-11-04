'use strict';
/**
 * qr.js - a QR code (ISO/IEC 18004) for a short text: byte mode, error correction M, versions 1-4
 * (up to 62 bytes: a URL to scan). No dependency.
 *
 *   encode(text, { mask }) -> rows of booleans (true = dark), size 21..33, no quiet zone; the mask
 *   (0-7) is chosen by the standard's penalty rules unless given (tests).
 *   draw(cv, text, x, y, mod) -> the code on a white square with its 4-module quiet zone, mod px a module,
 *   each row's dark runs one rect (works on every canvas: fillRect only). Returns the square's side.
 */

// per version 1..4 at level M: [data codewords per block, blocks, EC codewords per block, alignment centre]
const SPEC = [null, [16, 1, 10, 0], [28, 1, 16, 18], [44, 1, 26, 22], [32, 2, 18, 26]];

function gmul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z;
}
// Reed-Solomon: the generator's coefficients for deg EC codewords, then a block's remainder
function rsDivisor(deg) {
    const r = new Array(deg).fill(0);
    r[deg - 1] = 1;
    let root = 1;
    for (let i = 0; i < deg; i++) {
        for (let j = 0; j < deg; j++) { r[j] = gmul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
        root = gmul(root, 2);
    }
    return r;
}
function rsRemainder(data, div) {
    const r = div.map(() => 0);
    data.forEach((b) => {
        const f = b ^ r.shift();
        r.push(0);
        div.forEach((c, i) => { r[i] ^= gmul(c, f); });
    });
    return r;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

// the codewords: mode 0100, 8-bit count, the bytes, terminator, pad; then EC per block, interleaved
function codewords(bytes, ver) {
    const [nd, nb, ne] = SPEC[ver], cap = nd * nb;
    const bits = [];
    const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
    put(4, 4); put(bytes.length, 8);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, cap * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let p = 0xec; data.length < cap; p ^= 0xec ^ 0x11) data.push(p);
    const div = rsDivisor(ne), blocks = [];
    for (let b = 0; b < nb; b++) { const d = data.slice(b * nd, (b + 1) * nd); blocks.push({ d, e: rsRemainder(d, div) }); }
    const out = [];
    for (let i = 0; i < nd; i++) blocks.forEach((b) => out.push(b.d[i]));
    for (let i = 0; i < ne; i++) blocks.forEach((b) => out.push(b.e[i]));
    return out;
}

function penalty(m) {
    const n = m.length;
    let p = 0, dark = 0;
    const line = (get) => {
        for (let i = 0; i < n; i++) {
            let run = 1;
            for (let j = 1; j <= n; j++) {
                if (j < n && get(i, j) === get(i, j - 1)) { run++; continue; }
                if (run >= 5) p += run - 2;
                run = 1;
            }
            for (let j = 0; j + 11 <= n; j++) {          // 1:1:3:1:1 with 4 light on a side
                const s = Array.from({ length: 11 }, (_, k) => (get(i, j + k) ? 1 : 0)).join('');
                if (s === '10111010000' || s === '00001011101') p += 40;
            }
        }
    };
    line((i, j) => m[i][j]);
    line((i, j) => m[j][i]);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (m[y][x]) dark++;
        if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
    return p + 10 * Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5);
}

function encode(text, opts) {
    const bytes = Array.from(Buffer.from(String(text), 'utf8'));
    let ver = 1;
    while (ver <= 4 && SPEC[ver][0] * SPEC[ver][1] < bytes.length + 2) ver++;
    if (ver > 4) throw new Error('qr: text too long (' + bytes.length + ' bytes, at most 62)');
    const n = 17 + 4 * ver;
    const m = [], fn = [];
    for (let y = 0; y < n; y++) { m.push(new Array(n).fill(false)); fn.push(new Array(n).fill(false)); }
    const set = (x, y, v) => { if (x >= 0 && y >= 0 && x < n && y < n) { m[y][x] = v; fn[y][x] = true; } };
    // finders with their separators, timing, alignment, the dark module; the format areas reserved
    [[3, 3], [n - 4, 3], [3, n - 4]].forEach(([cx, cy]) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            set(cx + dx, cy + dy, d !== 2 && d !== 4);
        }
    });
    for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const al = SPEC[ver][3];
    if (al) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al + dx, al + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    const format = (mask) => {
        const d = mask;                                 // level M = 00
        let r = d;
        for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
        const bits = ((d << 10) | r) ^ 0x5412, b = (i) => ((bits >>> i) & 1) === 1;
        for (let i = 0; i <= 5; i++) set(8, i, b(i));
        set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
        for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
        for (let i = 0; i < 8; i++) set(n - 1 - i, 8, b(i));
        for (let i = 8; i < 15; i++) set(8, n - 15 + i, b(i));
        set(8, n - 8, true);
    };
    format(0);
    // the data, in two-column zigzags from the bottom right
    const cw = codewords(bytes, ver);
    let k = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let v = 0; v < n; v++) for (let j = 0; j < 2; j++) {
            const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - v : v;
            if (!fn[y][x] && k < cw.length * 8) { m[y][x] = ((cw[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
        }
    }
    const masked = (mask) => {
        const out = m.map((row, y) => row.map((v, x) => (!fn[y][x] && MASKS[mask](x, y) ? !v : v)));
        const keep = m.map((r) => r.slice());
        m.forEach((r, y) => r.forEach((_, x) => { m[y][x] = out[y][x]; }));
        format(mask);
        const res = m.map((r) => r.slice());
        keep.forEach((r, y) => r.forEach((v, x) => { m[y][x] = v; }));
        return res;
    };
    if (opts && opts.mask != null) return masked(opts.mask);
    let best = null, bestP = Infinity;
    for (let mask = 0; mask < 8; mask++) { const c = masked(mask), p = penalty(c); if (p < bestP) { best = c; bestP = p; } }
    return best;
}

function draw(cv, text, x, y, mod) {
    const q = encode(text), side = (q.length + 8) * mod;
    cv.fillRect(x, y, side, side, '#ffffff');
    q.forEach((row, r) => {
        for (let c = 0; c < row.length;) {
            if (!row[c]) { c++; continue; }
            let e = c;
            while (e < row.length && row[e]) e++;
            cv.fillRect(x + (4 + c) * mod, y + (4 + r) * mod, (e - c) * mod, mod, '#000000');
            c = e;
        }
    });
    return side;
}

module.exports = { encode, draw };
