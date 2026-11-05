'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
// node release/catalog.js <folder> <base url>: writes <folder>/catalog.json (MGU Store catalog, schema 2) for the
// artifacts in the folder, each with its size and sha256; <base url> is where they are downloaded from.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [dir, base] = process.argv.slice(2);
if (!dir || !/^https:\/\//.test(base || '')) { console.error('usage: node release/catalog.js <folder> <https base url>'); process.exit(2); }
const AUTHOR = 'JustAnotherPU';
const META = {
    jap_cams: { kind: 'app', title: 'Cameras', icon: 'jap_cams.png',
        description: 'Your UniFi Protect cameras on the iDrive 7 screen, parked only by default: the camera that matters big, the others beside it, a timeline of detections with their clips. Needs your own jap-cams server (Linux, ffmpeg) and a tunnel to it.',
        requires: (v) => ({ 'jap-cams': v['jap-cams'], 'mgu-render': '0.6.8' }) },
    'jap-cams': { kind: 'tool', title: 'Cameras service',
        description: "The Cameras app's background service: the stream and the events from your jap-cams server through a local SOCKS5 proxy, the H.264 decoder (Intel MSDK) into mgu-render",
        // jap-node22 comes from the JustAnotherPU/mgu-apps source (the Store resolves requires from any source)
        requires: () => ({ 'mgu-deploy': '0.7.0', 'jap-node22': '22.23.4' }) },
};
const files = fs.readdirSync(dir).filter((f) => /^[a-z0-9_-]+@\d+\.\d+\.\d+\.tgz$/.test(f)).sort();
const version = {};
files.forEach((f) => { const [id, v] = f.slice(0, -4).split('@'); if (!META[id]) throw new Error('unknown artifact ' + f); version[id] = v; });
Object.keys(META).forEach((id) => { if (!version[id]) throw new Error('missing artifact for ' + id); });
const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
const components = files.map((f) => {
    const [id, v] = f.slice(0, -4).split('@'), m = META[id];
    const c = { id, kind: m.kind, title: m.title, description: m.description, author: AUTHOR, version: v,
        artifact: { name: f, size: fs.statSync(path.join(dir, f)).size, sha256: hash(f), url: base + '/' + f },
        requires: m.requires(version), uninstallable: true, mguHmi: ['ID7'] };
    if (m.optional) c.optional = true;
    if (m.icon) { c.icon = m.icon; c.iconSha256 = hash(m.icon); }
    return c;
});
fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ schema: 2, components }, null, 2) + '\n');
console.log('catalog.json: ' + components.map((c) => c.id + '@' + c.version).join(', '));
