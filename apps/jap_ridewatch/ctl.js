'use strict';
/**
 * ctl.js - the app's end of the jap-ridewatch service (ridewatchd.js) control socket: JSON lines both ways.
 *
 *   const ctl = new Ctl(log);      // /run/jap-ridewatch/ctl.sock, or JAP_RIDEWATCH_CTL
 *   ctl.on('up', () => ...); ctl.on('down', () => ...); ctl.on('msg', (m) => ...);   // m: a daemon event ({ ev: ... })
 *   ctl.send({ cmd: 'status' });   // false while not connected (nothing is queued)
 *
 * Reconnects by itself: 0.5 s after a loss, doubling to 10 s, back to 0.5 s once connected.
 */
const net = require('net');
const EventEmitter = require('events');

const SOCK = process.env.JAP_RIDEWATCH_CTL || '/run/jap-ridewatch/ctl.sock';
const MIN_MS = 500, MAX_MS = 10000, MAX_LINE = 1 << 20;

class Ctl extends EventEmitter {
    constructor(log, path) {
        super();
        this.log = log;
        this.path = path || SOCK;
        this.sock = null;
        this.up = false;
        this.wait = MIN_MS;
        this.buf = '';
        this.warned = false;
    }

    connect() {
        const s = this.sock = net.createConnection(this.path);
        s.setEncoding('utf8');
        s.on('connect', () => {
            this.up = true; this.wait = MIN_MS; this.buf = ''; this.warned = false;
            this.log.info('ctl: connected to ' + this.path);
            this.emit('up');
        });
        s.on('data', (d) => this._data(d));
        s.on('error', (e) => { if (!this.warned) { this.warned = true; this.log.warn('ctl: ' + e.message); } });
        s.on('close', () => {
            const was = this.up;
            this.up = false; this.sock = null;
            if (was) { this.log.warn('ctl: connection closed'); this.emit('down'); }
            setTimeout(() => this.connect(), this.wait);
            this.wait = Math.min(MAX_MS, this.wait * 2);
        });
        return this;
    }

    send(obj) {
        if (!this.up || !this.sock) return false;
        return this.sock.write(JSON.stringify(obj) + '\n');
    }

    _data(d) {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
            const line = this.buf.slice(0, i).trim();
            this.buf = this.buf.slice(i + 1);
            if (!line) continue;
            let m = null;
            try { m = JSON.parse(line); } catch (e) { this.log.warn('ctl: not JSON: ' + line.slice(0, 80)); continue; }
            if (m && typeof m === 'object' && typeof m.ev === 'string') this.emit('msg', m);
            else this.log.warn('ctl: no "ev": ' + line.slice(0, 80));
        }
        // a daemon that never ends its line must not grow the app's memory
        if (this.buf.length > MAX_LINE) { this.log.warn('ctl: line over 1 MiB dropped'); this.buf = ''; }
    }
}

module.exports = { Ctl, SOCK };
