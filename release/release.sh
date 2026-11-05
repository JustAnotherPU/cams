#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
# Puts the Store release in dist/release/: the app package WITHOUT BMW's oap-sdk (the head unit generates that
# module from a stock app), the service's tool artifact, the app icon and catalog.json. Upload every file of
# that folder to the GitHub release named "catalog" (README.md, "Releasing"). jap-node22 and jap-tailscale come from
# github.com/JustAnotherPU/mgu-apps. Build first:
#   python3 kit/tools/build.py jap_cams && make -C native/camdec target && sh tools/jap-cams/build.sh
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/dist/release
base=${RELEASE_URL:-https://github.com/JustAnotherPU/cams/releases/download/catalog}
one() { set -- $1; [ $# -eq 1 ] && [ -f "$1" ] || { echo "release.sh: expected one $1" >&2; exit 1; }; echo "$1"; }
app=$(one "$root/dist/jap_cams@*.tgz")
rm -rf "$out" && mkdir -p "$out"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar -xzf "$app" -C "$tmp"
rm -rf "$tmp/package/node_modules/oap-sdk"; rmdir "$tmp/package/node_modules" 2>/dev/null || true
if tar --version 2>/dev/null | grep -q bsdtar; then own='--uid 0 --gid 0 --uname root --gname root'; else own='--owner=0 --group=0 --numeric-owner'; fi
(cd "$tmp" && tar $own -czf "$out/$(basename "$app")" package)
if tar -tzf "$out/$(basename "$app")" | grep -qi 'oap-sdk'; then echo "release.sh: the oap-sdk is still in the package" >&2; exit 1; fi
# the local build's packages hold BMW's oap-sdk: only dist/release/ is ever uploaded, so they go
rm -f "$app" "${app%.tgz}.mgu"
for t in jap-cams; do cp "$(one "$root/dist/$t@*.tgz")" "$out/"; done
cp "$root/apps/jap_cams/icon.png" "$out/jap_cams.png"
node "$root/release/catalog.js" "$out" "$base"
ls -la "$out"
