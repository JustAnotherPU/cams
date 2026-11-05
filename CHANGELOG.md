# Changelog

## 0.3.0

First public release.

- The app, the service and the server no longer assume one home: the server address, the ports and the location
  are app settings, and the cameras' roles (door, garage, day, night) are set on the server.
- The car makes its own code at the first start and shows it while the server refuses it; `configure.py --add-car`
  lets it in.
- `server/install.sh` and `server/configure.py`: the server is installed in one command, finds the cameras and their
  RTSPS channels in Protect and writes `cams.json` itself.
- The detections are read from Protect's event list by default; Home Assistant stays possible as a source.
- Parked only is on by default.
- Everything is in English.
