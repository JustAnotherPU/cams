// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
// Modified 2026-11 by JustAnotherPU (camdec: see README.md, "Where the code comes from")
/* camdec's copy of ytdec's decoder_msdk.cpp: VPP removed, system-memory
 * output, decoding order, frames held by the caller (decoder_msdk.h). */
#include "decoder_msdk.h"

#include "mfx/mfxvideo.h"

#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include <atomic>
#include <vector>

/* libva, from va/va.h and va/va_drm.h; the unit has libva.so.1 and
 * libva-drm.so.1 (1.9900.0). */
extern "C" {
typedef void *VADisplay;
typedef int VAStatus;
#define VA_STATUS_SUCCESS 0x00000000
VADisplay vaGetDisplayDRM(int fd);
VAStatus vaInitialize(VADisplay dpy, int *major_version, int *minor_version);
VAStatus vaTerminate(VADisplay dpy);
const char *vaErrorStr(VAStatus error_status);
}

namespace woc {

namespace {

const mfxU32 kSyncTimeoutMs = 1000;   /* longest wait for one frame */
const int kBusyRetries = 1000;        /* MFX_WRN_DEVICE_BUSY retries, 1 ms apart */
const int kStallLimit = 64;           /* decode calls in a row that neither output nor consume */

const char *status_name(mfxStatus s)
{
    switch (s) {
    case MFX_ERR_NONE: return "MFX_ERR_NONE";
    case MFX_ERR_UNKNOWN: return "MFX_ERR_UNKNOWN";
    case MFX_ERR_NULL_PTR: return "MFX_ERR_NULL_PTR";
    case MFX_ERR_UNSUPPORTED: return "MFX_ERR_UNSUPPORTED";
    case MFX_ERR_MEMORY_ALLOC: return "MFX_ERR_MEMORY_ALLOC";
    case MFX_ERR_NOT_ENOUGH_BUFFER: return "MFX_ERR_NOT_ENOUGH_BUFFER";
    case MFX_ERR_INVALID_HANDLE: return "MFX_ERR_INVALID_HANDLE";
    case MFX_ERR_LOCK_MEMORY: return "MFX_ERR_LOCK_MEMORY";
    case MFX_ERR_NOT_INITIALIZED: return "MFX_ERR_NOT_INITIALIZED";
    case MFX_ERR_NOT_FOUND: return "MFX_ERR_NOT_FOUND";
    case MFX_ERR_MORE_DATA: return "MFX_ERR_MORE_DATA";
    case MFX_ERR_MORE_SURFACE: return "MFX_ERR_MORE_SURFACE";
    case MFX_ERR_ABORTED: return "MFX_ERR_ABORTED";
    case MFX_ERR_DEVICE_LOST: return "MFX_ERR_DEVICE_LOST";
    case MFX_ERR_INCOMPATIBLE_VIDEO_PARAM: return "MFX_ERR_INCOMPATIBLE_VIDEO_PARAM";
    case MFX_ERR_INVALID_VIDEO_PARAM: return "MFX_ERR_INVALID_VIDEO_PARAM";
    case MFX_ERR_UNDEFINED_BEHAVIOR: return "MFX_ERR_UNDEFINED_BEHAVIOR";
    case MFX_ERR_DEVICE_FAILED: return "MFX_ERR_DEVICE_FAILED";
    case MFX_ERR_MORE_BITSTREAM: return "MFX_ERR_MORE_BITSTREAM";
    case MFX_ERR_INCOMPATIBLE_AUDIO_PARAM: return "MFX_ERR_INCOMPATIBLE_AUDIO_PARAM";
    case MFX_ERR_INVALID_AUDIO_PARAM: return "MFX_ERR_INVALID_AUDIO_PARAM";
    case MFX_ERR_GPU_HANG: return "MFX_ERR_GPU_HANG";
    case MFX_ERR_REALLOC_SURFACE: return "MFX_ERR_REALLOC_SURFACE";
    case MFX_WRN_IN_EXECUTION: return "MFX_WRN_IN_EXECUTION";
    case MFX_WRN_DEVICE_BUSY: return "MFX_WRN_DEVICE_BUSY";
    case MFX_WRN_VIDEO_PARAM_CHANGED: return "MFX_WRN_VIDEO_PARAM_CHANGED";
    case MFX_WRN_PARTIAL_ACCELERATION: return "MFX_WRN_PARTIAL_ACCELERATION";
    case MFX_WRN_INCOMPATIBLE_VIDEO_PARAM: return "MFX_WRN_INCOMPATIBLE_VIDEO_PARAM";
    case MFX_WRN_VALUE_NOT_CHANGED: return "MFX_WRN_VALUE_NOT_CHANGED";
    case MFX_WRN_OUT_OF_RANGE: return "MFX_WRN_OUT_OF_RANGE";
    case MFX_WRN_FILTER_SKIPPED: return "MFX_WRN_FILTER_SKIPPED";
    case MFX_WRN_INCOMPATIBLE_AUDIO_PARAM: return "MFX_WRN_INCOMPATIBLE_AUDIO_PARAM";
    }
    return "unknown status";
}

std::string mfx_error(const char *call, mfxStatus s)
{
    return std::string(call) + ": " + status_name(s) + " (" + std::to_string(s) + ")";
}

void wrap(mfxBitstream *bs, const uint8_t *au, size_t len)
{
    memset(bs, 0, sizeof *bs);
    bs->TimeStamp = (mfxU64)-1;   /* MFX_TIMESTAMP_UNKNOWN: camdec paces by the SPS rate */
    bs->Data = const_cast<mfxU8 *>(au);
    bs->DataLength = bs->MaxLength = (mfxU32)len;
    /* camdec's feeder only delivers whole access units. */
    bs->DataFlag = MFX_BITSTREAM_COMPLETE_FRAME;
}

bool has_sps(const uint8_t *d, size_t len)
{
    for (size_t i = 0; i + 3 < len; i++)
        if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) {
            if ((d[i + 3] & 0x1f) == 7)
                return true;
            i += 2;
        }
    return false;
}

/* One system-memory output surface. The decoder may write into it only while
 * no frame handed out holds it (`held`) and MSDK does not lock it. */
struct Surface {
    mfxFrameSurface1 s;
    uint8_t *mem = nullptr;
    std::atomic<bool> held{false};
    ~Surface() { free(mem); }
};

}  // namespace

struct Decoder::State {
    int fd = -1;
    VADisplay va = nullptr;
    mfxSession session = nullptr;
    std::string error;               /* first hard error of the current call */

    bool running = false;            /* a sequence is initialised */
    mfxVideoParam dec;
    std::vector<std::shared_ptr<Surface>> pool;
    uint32_t w = 0, h = 0;

    enum Result { Ok, Failed, Restart };

    ~State();
    bool open_session();
    void access_unit(const uint8_t *au, size_t len, const FrameSink &cb);
    bool start(const uint8_t *au, size_t len);
    void stop();
    Result decode(mfxBitstream *bs, const FrameSink &cb);
    bool fail(const std::string &msg)
    {
        if (error.empty()) error = msg;
        return false;
    }
};

Decoder::State::~State()
{
    /* The session uses the VA display, so it closes first. */
    stop();
    if (va) vaTerminate(va);
    if (fd >= 0) close(fd);
}

bool Decoder::State::open_session()
{
    mfxVersion ver;
    ver.Major = MFX_VERSION_MAJOR;
    ver.Minor = MFX_VERSION_MINOR;
    /* GPU copy: the decoder's copy of its tiled GPU surface into our system
     * memory is done by the GPU, not by a CPU thread (ytdec measured ~50 % of
     * a core for that thread at 720p30). CAMDEC_GPUCOPY=0/1/2 overrides
     * (default/on/off), for measuring. */
    mfxInitParam ip;
    memset(&ip, 0, sizeof ip);
    ip.Implementation = MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI;
    ip.Version = ver;
    const char *gc = getenv("CAMDEC_GPUCOPY");
    ip.GPUCopy = gc ? (mfxU16)atoi(gc) : (mfxU16)MFX_GPUCOPY_ON;
    mfxStatus sts = MFXInitEx(ip, &session);
    if (sts < MFX_ERR_NONE)
        sts = MFXInit(MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI, &ver, &session);
    if (sts < MFX_ERR_NONE) {
        session = nullptr;
        return fail(mfx_error("MFXInit", sts));
    }
    sts = MFXVideoCORE_SetHandle(session, MFX_HANDLE_VA_DISPLAY, va);
    if (sts < MFX_ERR_NONE) {
        MFXClose(session);
        session = nullptr;
        return fail(mfx_error("MFXVideoCORE_SetHandle", sts));
    }
    return true;
}

void Decoder::State::access_unit(const uint8_t *au, size_t len, const FrameSink &cb)
{
    for (int attempt = 0; attempt < 2; attempt++) {
        if (!running) {
            if (!has_sps(au, len))
                return;   /* nothing decodes before a sequence header */
            if (!start(au, len)) {
                stop();
                return;
            }
            if (!running)
                return;
        }
        mfxBitstream bs;
        wrap(&bs, au, len);
        Result r = decode(&bs, cb);
        if (r != Restart)
            return;
        /* The access unit starts a sequence that needs a larger picture or
         * more surfaces: reinitialise from it. */
        decode(nullptr, cb);
        stop();
    }
    fail("decoder rejected the new sequence after reinitialising");
}

/* Every sequence gets a fresh session (ytdec: reinitialising in the same
 * session reused a closed pool with the unit's MSDK release). */
bool Decoder::State::start(const uint8_t *au, size_t len)
{
    if (!session && !open_session())
        return false;

    mfxBitstream bs;
    wrap(&bs, au, len);
    memset(&dec, 0, sizeof dec);
    dec.mfx.CodecId = MFX_CODEC_AVC;
    mfxStatus sts = MFXVideoDECODE_DecodeHeader(session, &bs, &dec);
    if (sts == MFX_ERR_MORE_DATA)
        return true;   /* SPS without its PPS: wait for the next SPS */
    if (sts < MFX_ERR_NONE)
        return fail(mfx_error("MFXVideoDECODE_DecodeHeader", sts));

    /* One frame in flight, decoding order: no reorder wait (no B frames). */
    dec.AsyncDepth = 1;
    dec.IOPattern = MFX_IOPATTERN_OUT_SYSTEM_MEMORY;
    dec.mfx.DecodedOrder = 1;

    const mfxFrameInfo &in = dec.mfx.FrameInfo;
    w = in.CropW;
    h = in.CropH;

    mfxFrameAllocRequest req;
    memset(&req, 0, sizeof req);
    sts = MFXVideoDECODE_QueryIOSurf(session, &dec, &req);
    if (sts < MFX_ERR_NONE)
        return fail(mfx_error("MFXVideoDECODE_QueryIOSurf", sts));
    const int n = req.NumFrameSuggested + kHeldFrames;

    /* NV12 = Y plane, then U,V interleaved at half height. Page-aligned
     * memory and a 64-byte pitch: what MSDK's GPU copy wants to map. */
    const uint32_t pitch = ((uint32_t)in.Width + 63) & ~63u;
    const size_t bytes = (size_t)pitch * in.Height * 3 / 2;
    pool.clear();
    for (int i = 0; i < n; i++) {
        std::shared_ptr<Surface> s(new Surface);
        void *m = nullptr;
        if (posix_memalign(&m, 4096, bytes) != 0)
            return fail("out of memory for decode surfaces");
        s->mem = (uint8_t *)m;
        memset(&s->s, 0, sizeof s->s);
        s->s.Info = in;
        s->s.Data.Y = s->mem;
        s->s.Data.UV = s->mem + (size_t)pitch * in.Height;
        s->s.Data.Pitch = (mfxU16)pitch;
        pool.push_back(s);
    }

    sts = MFXVideoDECODE_Init(session, &dec);
    if (sts < MFX_ERR_NONE)
        return fail(mfx_error("MFXVideoDECODE_Init", sts));
    running = true;
    return true;
}

void Decoder::State::stop()
{
    if (running) {
        MFXVideoDECODE_Close(session);
        running = false;
    }
    if (session) {
        MFXClose(session);
        session = nullptr;
    }
    pool.clear();   /* frames still held keep their own surface alive */
}

/* Decodes everything in bs, or with bs null drains the frames the decoder
 * holds, until MSDK asks for more data. */
Decoder::State::Result Decoder::State::decode(mfxBitstream *bs, const FrameSink &cb)
{
    int busy = 0, stalls = 0;
    for (;;) {
        Surface *work = nullptr;
        for (auto &s : pool) {
            if (!s->s.Data.Locked && !s->held.load(std::memory_order_acquire)) {
                work = s.get();
                break;
            }
        }
        if (!work) {
            fail("no free decode surface");
            return Failed;
        }
        mfxFrameSurface1 *out = nullptr;
        mfxSyncPoint sync = nullptr;
        mfxStatus sts = MFXVideoDECODE_DecodeFrameAsync(session, bs, &work->s, &out, &sync);
        if (sts == MFX_WRN_DEVICE_BUSY) {
            if (++busy > kBusyRetries) {
                fail(mfx_error("MFXVideoDECODE_DecodeFrameAsync", sts));
                return Failed;
            }
            usleep(1000);
            continue;
        }
        busy = 0;
        if (sts == MFX_ERR_MORE_DATA)
            return Ok;
        if (sts == MFX_ERR_INCOMPATIBLE_VIDEO_PARAM && bs)
            return Restart;
        if (sts < MFX_ERR_NONE && sts != MFX_ERR_MORE_SURFACE) {
            fail(mfx_error("MFXVideoDECODE_DecodeFrameAsync", sts));
            return Failed;
        }
        if (!sync) {
            if (++stalls > kStallLimit) {
                fail(mfx_error("MFXVideoDECODE_DecodeFrameAsync makes no progress", sts));
                return Failed;
            }
            continue;
        }
        stalls = 0;
        sts = MFXVideoCORE_SyncOperation(session, sync, kSyncTimeoutMs);
        if (sts != MFX_ERR_NONE) {
            fail(mfx_error("MFXVideoCORE_SyncOperation", sts));
            return Failed;
        }
        /* `out` is one of our surfaces; find its owner to hand it out. */
        std::shared_ptr<Surface> owner;
        for (auto &s : pool)
            if (&s->s == out)
                owner = s;
        if (!owner) {
            fail("decoder returned a surface that is not ours");
            return Failed;
        }
        owner->held.store(true, std::memory_order_relaxed);
        const mfxFrameInfo &fi = out->Info;
        const uint32_t pitch = out->Data.Pitch;
        VideoFrame f;
        f.w = fi.CropW ? fi.CropW : w;
        f.h = fi.CropH ? fi.CropH : h;
        f.corrupted = out->Data.Corrupted;
        f.pitch = pitch;
        f.y = out->Data.Y + (size_t)fi.CropY * pitch + fi.CropX;
        f.uv = out->Data.UV + (size_t)(fi.CropY / 2) * pitch + (fi.CropX & ~1u);
        /* The last copy of hold gives the surface back to the decoder. */
        f.hold = std::shared_ptr<void>(owner.get(), [owner](void *) {
            owner->held.store(false, std::memory_order_release);
        });
        cb(f);
    }
}

Decoder::Decoder() {}

Decoder::~Decoder() { shutdown(); }

bool Decoder::init(const char *dev, std::string *err)
{
    shutdown();
    std::unique_ptr<State> s(new State);
    s->fd = open(dev, O_RDWR | O_CLOEXEC);
    if (s->fd < 0) {
        *err = std::string("open ") + dev + ": " + strerror(errno);
        return false;
    }
    s->va = vaGetDisplayDRM(s->fd);
    if (!s->va) {
        *err = "vaGetDisplayDRM failed";
        return false;
    }
    int major = 0, minor = 0;
    VAStatus vs = vaInitialize(s->va, &major, &minor);
    if (vs != VA_STATUS_SUCCESS) {
        *err = std::string("vaInitialize: ") + vaErrorStr(vs);
        return false;
    }
    /* Opened now to report a missing or refusing MSDK early (exit 1). */
    if (!s->open_session()) {
        *err = s->error;
        return false;
    }
    s_ = std::move(s);
    return true;
}

bool Decoder::feed(const uint8_t *au, size_t len, const FrameSink &cb, std::string *err)
{
    if (!s_) {
        *err = "decoder not initialised";
        return false;
    }
    State &s = *s_;
    s.error.clear();
    s.access_unit(au, len, cb);
    if (!s.error.empty()) {
        *err = s.error;
        return false;
    }
    return true;
}

void Decoder::reset()
{
    if (s_) {
        s_->stop();
        s_->error.clear();
    }
}

void Decoder::shutdown() { s_.reset(); }

}  // namespace woc
