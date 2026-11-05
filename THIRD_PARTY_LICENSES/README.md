# Third-party components

Cameras (jap-cams) is GPL-3.0-or-later (`../LICENSE`). It is built with, or ships, the components below. Each
licence text is in this folder; files that carry their own copyright headers keep them.

| Component | Where | Licence | File |
|---|---|---|---|
| jpeg-js 0.4.4 (decoder only, github.com/jpeg-js/jpeg-js) | `daemon/vendor/jpeg-js`, in the `jap-cams` package | BSD-3-Clause; `decoder.js` itself is Apache-2.0 (Copyright 2011 notmasteryet, from pdf.js, as its header says) | `jpeg-js.LICENSE` (also beside the code), `Apache-2.0.txt` |
| Intel Media SDK headers | `native/camdec/abi/include/mfx` (headers only, to build against the head unit's library) | MIT | `intel-mediasdk-headers.LICENSE` |
| App kit (`kit/`), from github.com/cauliflowermossgrape/idrive7-apps, modified | `kit/`, in the `jap_cams` package | MIT | `app-kit.LICENSE` (also `kit/LICENSE`) |
| Noto Sans SC glyphs (in the kit's fonts) | `kit/runtime/fonts/cjk.json` | SIL OFL 1.1 | `noto-sans-sc.OFL.txt` (also beside the fonts) |
| Ubuntu font glyphs, rasterised (in the kit's fonts) | `kit/runtime/fonts/{label,bold,num,light,gear}.json` | Ubuntu Font Licence 1.0 | `ubuntu-font.UFL-1.0.txt` (also beside the fonts) |

The `jap-cams` tool package carries `LICENSE`, the jpeg-js licences and the Media SDK headers' licence; the app
package carries `LICENSE`, the kit's licence and the font licences.

Files copied from github.com/robertnisipeanu/idrive-apps (Copyright (C) 2026 Robert Nisipeanu, GPL-3.0-or-later
unless noted; their headers are kept), most of them through RideTube's `native/ytdec`:

- `native/camdec/src/decoder_msdk.cpp`, `decoder_msdk.h` (from `native/waze-on-cluster/src`), modified 2026-11 by
  JustAnotherPU, as noted in each file
- `native/camdec/src/nal_reader.cpp`, `nal_reader.h`, `native/camdec/test/nal_reader_test.cpp` (from
  `native/waze-on-cluster`), unchanged
- `native/camdec/abi/libmfx.symbols`, `libva.symbols`, `libva-drm.symbols` (from `native/waze-on-cluster/abi`),
  unchanged: exported symbol names of the head unit's libraries
- `native/camdec/abi/libvsomeip3.so.3.symbols` (from `native/cluster-render/dcsm/abi`, MPL-2.0 as its header
  says: vsomeip's symbol names), unchanged
- `native/camdec/tools/abi.py` (from `native/cluster-render/dcsm/tools`), `ramses_abi.py` (from
  `native/cluster-render/tools`), `woc_abi.py` (from `native/waze-on-cluster/tools`), unchanged
- `native/camdec/docker/Dockerfile` (from `native/cluster-render/docker`), unchanged

The symbol lists are used only to check the binary's imports.
