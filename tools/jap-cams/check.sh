#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# mgu-deploy "check", offline on purpose: camdec loads (glibc, MSDK, libva resolve; without arguments it exits 2 by
# its contract, a loader failure is 127) and node22 parses and loads the daemon (its modules), without starting it.
set -u
d=$(cd "$(dirname "$0")" && pwd)
"$d/camdec" >/dev/null 2>&1
rc=$?
[ "$rc" -eq 2 ] || { echo "check: camdec without arguments exited $rc, not 2 (missing library?)" >&2; exit 1; }
/var/opt/jap-node22/current/bin/node --check "$d/camsd.js" || exit 1
exec /var/opt/jap-node22/current/bin/node -e "require('$d/camsd.js')"   # loads socks.js and jpeg-js, starts nothing
