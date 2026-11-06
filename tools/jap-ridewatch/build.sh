#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
# Packs the tool artifact dist/jap-ridewatch@<version>.tgz with the MGU Store's packer (deploy/hu artifact: sha256 per
# file). Needs a checkout of https://github.com/robertnisipeanu/mgu-store in $MGU_STORE.
# Build the decoder first: make -C ../../native/camdec target (CAMDEC= another path to the car build)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$here/../..
store=${MGU_STORE:?set MGU_STORE to a checkout of github.com/robertnisipeanu/mgu-store}
bin=${CAMDEC:-$root/native/camdec/build/target/camdec}
file -L "$bin" | grep -q 'ELF 64-bit.*x86-64' || { echo "build.sh: $bin is not an x86-64 ELF (make -C native/camdec target first)" >&2; exit 1; }
rm -rf "$here/build"
mkdir -p "$here/build/vendor/jpeg-js" "$here/build/licenses"
cp "$bin" "$here/build/camdec"
cp "$root/daemon/ridewatchd.js" "$root/daemon/socks.js" "$here/build/"
cp "$root/daemon/vendor/jpeg-js/decoder.js" "$root/daemon/vendor/jpeg-js/LICENSE" "$root/daemon/vendor/jpeg-js/Apache-2.0.txt" "$here/build/vendor/jpeg-js/"
cp "$root/LICENSE" "$here/build/LICENSE"
cp "$root/THIRD_PARTY_LICENSES/intel-mediasdk-headers.LICENSE" "$here/build/licenses/"
node --check "$here/build/ridewatchd.js"
node --check "$here/build/socks.js"
(cd "$here/build" && node -e "require('./ridewatchd.js')")      # loads (socks, jpeg-js) without starting
node "$store/deploy/hu" artifact "$here" --out "$root/dist"
