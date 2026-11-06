# Changelog

## 0.3.1

- Renamed to RideWatch: the app is `jap_ridewatch`, its service `jap-ridewatch`, and the server's user, folders and
  units say `ridewatch` too. Install the server again with `server/install.sh`, then set the Server IP in the app
  and add the car's new code.
- README: which cameras work with what (Protect, other RTSP cameras).
- The video frames go to `/dev/shm/mgu-video-ridewatch`: mgu-render only reads frame files named
  `/dev/shm/mgu-video-*`, and refused the previous path.

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
