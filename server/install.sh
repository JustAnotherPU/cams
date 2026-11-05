#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 JustAnotherPU
# Installs the jap-cams server on this Linux machine (Debian or Ubuntu with systemd), from a checkout of the repository:
#   sudo bash server/install.sh [listen address]        (default 0.0.0.0: every interface)
# Adds ffmpeg (apt) if missing, a system user "japcams", /opt/jap-cams (the scripts and cams.json), the stream socket on
# port 18640 and the events service, runs the selftests, then configure.py (asks for Protect and the cameras' roles).
# Run it again to update the scripts; cams.json is kept (configure.py asks again, Enter keeps each answer).
# Remove: systemctl disable --now jap-cams.socket jap-cams-events.service
#         rm -r /opt/jap-cams /var/lib/jap-cams /etc/systemd/system/jap-cams*; userdel japcams
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
listen=${1:-0.0.0.0}
[ "$(id -u)" = 0 ] || { echo "install.sh: run it as root (sudo)" >&2; exit 2; }
[[ $listen =~ ^[0-9.]+$ || $listen =~ ^\[[0-9a-fA-F:]+\]$ ]] || { echo "install.sh: $listen is not an IPv4 or [IPv6] address" >&2; exit 2; }
command -v systemctl >/dev/null || { echo "install.sh: needs systemd" >&2; exit 2; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 7))' || { echo "install.sh: needs Python 3.7 or newer" >&2; exit 2; }
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    command -v apt-get >/dev/null || { echo "install.sh: install ffmpeg first" >&2; exit 2; }
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg >/dev/null
fi
ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libx264 || { echo "install.sh: this ffmpeg has no libx264" >&2; exit 2; }
id japcams >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /nonexistent japcams
install -d -m 755 /opt/jap-cams
install -m 755 "$here/serve.py" "$here/events.py" "$here/configure.py" /opt/jap-cams/
install -d -m 700 -o japcams -g japcams /var/lib/jap-cams
sed "s/@LISTEN@/$listen/" "$here/jap-cams.socket" > /etc/systemd/system/jap-cams.socket
install -m 644 "$here/jap-cams@.service" "$here/jap-cams-events.service" /etc/systemd/system/
python3 /opt/jap-cams/serve.py --selftest
python3 /opt/jap-cams/events.py --selftest
python3 /opt/jap-cams/configure.py --selftest
python3 /opt/jap-cams/configure.py </dev/tty
systemctl daemon-reload
systemctl enable --now jap-cams.socket
systemctl enable jap-cams-events.service
systemctl restart jap-cams-events.service
systemctl is-active jap-cams.socket jap-cams-events.service
echo
echo "Listening on $listen:18640. In the car: Cameras, Settings, set the server's IP; the app then shows the car's code."
echo "Add it here: sudo python3 /opt/jap-cams/configure.py --add-car <code>"
