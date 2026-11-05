// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
'use strict';
/**
 * socks.js - one TCP connection through a local SOCKS5 proxy (the car has no TUN; a tunnel such as Tailscale offers
 * one on 127.0.0.1), Moonride's relay.js socks() for CONNECT only.
 *
 *   const { sock, rest } = await connect('127.0.0.1', 1065, '192.0.2.10', 18640);   // rest: bytes after the reply
 */
const net = require('net');

/** SOCKS5 address block for an IPv4 target. */
function addr(ip, port) {
    const b = Buffer.alloc(6);
    ip.split('.').forEach((n, i) => { b[i] = +n; });
    b.writeUInt16BE(port, 4);
    return b;
}
/** Length of a SOCKS5 address block (atyp byte included) at buf[i], or -1 when incomplete. */
function addrLen(buf, i) {
    if (buf.length <= i) return -1;
    const t = buf[i], n = t === 1 ? 7 : t === 4 ? 19 : t === 3 && buf.length > i + 1 ? 4 + buf[i + 1] : -1;
    return n > 0 && buf.length >= i + n ? n : -1;
}

function connect(socksHost, socksPort, ip, port) {
    return new Promise((resolve, reject) => {
        const s = net.connect(socksPort, socksHost);
        let stage = 0, buf = Buffer.alloc(0);
        const fail = (e) => { s.destroy(); reject(e instanceof Error ? e : new Error('socks: ' + e)); };
        s.setTimeout(5000, () => fail('timeout'));
        s.on('error', fail);
        s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
        s.on('data', function onData(d) {
            buf = Buffer.concat([buf, d]);
            if (stage === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 5 || buf[1] !== 0) return fail('auth refused');
                buf = buf.slice(2); stage = 1;
                s.write(Buffer.concat([Buffer.from([5, 1, 0, 1]), addr(ip, port)]));
            }
            if (buf.length < 4) return;
            if (buf[1] !== 0) return fail('reply ' + buf[1]);
            const n = addrLen(buf, 3);
            if (n < 0) return;
            s.removeListener('data', onData);
            s.removeListener('error', fail);
            s.setTimeout(0);
            resolve({ sock: s, rest: buf.slice(3 + n) });
        });
    });
}

module.exports = { connect };
