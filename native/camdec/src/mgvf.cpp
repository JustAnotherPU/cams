// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 JustAnotherPU
#include "mgvf.h"

#include <errno.h>
#include <fcntl.h>
#include <pwd.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__SSE2__)
#include <emmintrin.h>
#endif

namespace camdec {

bool Mgvf::open(const char *path, uint32_t w, uint32_t h, int nslot, std::string *err, std::string *warn)
{
    close();
    if (w % 2 || h % 2 || w < 16 || h < 16 || w > 2048 || h > 2048) {
        *err = "frame size must be even, 16..2048";
        return false;
    }
    if ((size_t)w * h * 3 > kMgvfAppLimit) {
        *err = "frame size over the renderer's 12 MiB per-app video limit";
        return false;
    }
    if (nslot < 1 || nslot > 4) {
        *err = "nslot must be 1..4";
        return false;
    }
    /* No link following: a planted symlink would make root write elsewhere. */
    int fd = ::open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) {
        *err = std::string("open ") + path + ": " + strerror(errno);
        return false;
    }
    struct stat st;
    if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode)) {
        ::close(fd);
        *err = std::string(path) + " is not a regular file";
        return false;
    }
    const struct passwd *pw = getpwnam("nobody");
    const uid_t nobody = pw ? pw->pw_uid : 65534;
    const gid_t nogroup = pw ? pw->pw_gid : 65534;
    if (st.st_uid != nobody && fchown(fd, nobody, nogroup) != 0)
        *warn = std::string("fchown nobody: ") + strerror(errno) + " (the file stays ours)";
    fchmod(fd, 0600);
    const size_t len = sizeof(MgvfHead) + (size_t)nslot * w * h * 3 / 2;
    if (ftruncate(fd, 0) != 0 || ftruncate(fd, (off_t)len) != 0) {
        *err = std::string("ftruncate: ") + strerror(errno);
        ::close(fd);
        return false;
    }
    void *p = mmap(nullptr, len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    ::close(fd);
    if (p == MAP_FAILED) {
        *err = std::string("mmap: ") + strerror(errno);
        return false;
    }
    head_ = (MgvfHead *)p;
    len_ = len;
    w_ = w, h_ = h;
    uint8_t *frames = (uint8_t *)p + sizeof(MgvfHead);
    for (int i = 0; i < nslot; i++) {
        uint8_t *f = frames + (size_t)i * frame_size();
        memset(f, 16, (size_t)w * h);
        memset(f + (size_t)w * h, 128, (size_t)w * h / 2);
    }
    MgvfHead hd;
    memset(&hd, 0, sizeof hd);
    hd.version = 1, hd.w = w, hd.h = h, hd.nslot = (uint32_t)nslot;
    hd.matrix = 1;   /* BT.709 */
    hd.full = 0;     /* limited range */
    memcpy(head_, &hd, sizeof hd);
    __atomic_store_n(&head_->magic, kMgvfMagic, __ATOMIC_RELEASE);
    return true;
}

uint8_t *Mgvf::begin()
{
    const uint32_t next = (head_->slot + 1) % head_->nslot;
    return (uint8_t *)head_ + sizeof(MgvfHead) + (size_t)next * frame_size();
}

void Mgvf::commit()
{
    nv12_fence();   /* non-temporal stores are weakly ordered: drain them before the release */
    const uint32_t next = (head_->slot + 1) % head_->nslot;
    __atomic_store_n(&head_->slot, next, __ATOMIC_RELEASE);
    __atomic_store_n(&head_->seq, head_->seq + 1, __ATOMIC_RELEASE);
}

void Mgvf::close()
{
    if (head_)
        munmap(head_, len_);
    head_ = nullptr;
}

void nv12_to_i420_ref(const uint8_t *y, const uint8_t *uv, size_t pitch, uint32_t w, uint32_t h, uint8_t *dst)
{
    for (uint32_t r = 0; r < h; r++)
        memcpy(dst + (size_t)r * w, y + r * pitch, w);
    uint8_t *u = dst + (size_t)w * h, *v = u + (size_t)w * h / 4;
    const uint32_t cw = w / 2;
    for (uint32_t r = 0; r < h / 2; r++) {
        const uint8_t *s = uv + r * pitch;
        uint8_t *du = u + (size_t)r * cw, *dv = v + (size_t)r * cw;
        for (uint32_t c = 0; c < cw; c++) {
            du[c] = s[2 * c];
            dv[c] = s[2 * c + 1];
        }
    }
}

#if defined(__SSE2__)

namespace {

inline bool aligned16(const void *p) { return ((uintptr_t)p & 15) == 0; }

template <bool NT>
inline void store(uint8_t *d, __m128i v)
{
    if (NT)
        _mm_stream_si128((__m128i *)d, v);
    else
        _mm_storeu_si128((__m128i *)d, v);
}

template <bool NT>
void copy_row(const uint8_t *s, uint8_t *d, uint32_t n)
{
    uint32_t i = 0;
    for (; i + 64 <= n; i += 64) {
        __m128i a = _mm_loadu_si128((const __m128i *)(s + i)), b = _mm_loadu_si128((const __m128i *)(s + i + 16));
        __m128i c = _mm_loadu_si128((const __m128i *)(s + i + 32)), e = _mm_loadu_si128((const __m128i *)(s + i + 48));
        store<NT>(d + i, a), store<NT>(d + i + 16, b), store<NT>(d + i + 32, c), store<NT>(d + i + 48, e);
    }
    for (; i + 16 <= n; i += 16)
        store<NT>(d + i, _mm_loadu_si128((const __m128i *)(s + i)));
    memcpy(d + i, s + i, n - i);
}

/* cw chroma pairs UVUV.. -> cw U, cw V; 16 pairs per step */
template <bool NT>
void split_row(const uint8_t *s, uint8_t *du, uint8_t *dv, uint32_t cw)
{
    const __m128i lo = _mm_set1_epi16(0x00ff);
    uint32_t c = 0;
    for (; c + 16 <= cw; c += 16) {
        const __m128i a = _mm_loadu_si128((const __m128i *)(s + 2 * c));
        const __m128i b = _mm_loadu_si128((const __m128i *)(s + 2 * c + 16));
        store<NT>(du + c, _mm_packus_epi16(_mm_and_si128(a, lo), _mm_and_si128(b, lo)));
        store<NT>(dv + c, _mm_packus_epi16(_mm_srli_epi16(a, 8), _mm_srli_epi16(b, 8)));
    }
    for (; c < cw; c++) {
        du[c] = s[2 * c];
        dv[c] = s[2 * c + 1];
    }
}

}  // namespace

void nv12_to_i420(const uint8_t *y, const uint8_t *uv, size_t pitch, uint32_t w, uint32_t h, uint8_t *dst)
{
    for (uint32_t r = 0; r < h; r++) {
        uint8_t *d = dst + (size_t)r * w;
        if (aligned16(d))
            copy_row<true>(y + r * pitch, d, w);
        else
            copy_row<false>(y + r * pitch, d, w);
    }
    uint8_t *u = dst + (size_t)w * h, *v = u + (size_t)w * h / 4;
    const uint32_t cw = w / 2;
    for (uint32_t r = 0; r < h / 2; r++) {
        uint8_t *du = u + (size_t)r * cw, *dv = v + (size_t)r * cw;
        if (aligned16(du) && aligned16(dv))
            split_row<true>(uv + r * pitch, du, dv, cw);
        else
            split_row<false>(uv + r * pitch, du, dv, cw);
    }
}

void nv12_fence() { _mm_sfence(); }

#else   /* host builds without SSE2 (the arm64 Mac): the reference loop */

void nv12_to_i420(const uint8_t *y, const uint8_t *uv, size_t pitch, uint32_t w, uint32_t h, uint8_t *dst)
{
    nv12_to_i420_ref(y, uv, pitch, w, h, dst);
}

void nv12_fence() {}

#endif

}  // namespace camdec
