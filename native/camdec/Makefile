# camdec: the live H.264 decoder of jap-cams. README.md.
#
#   make test     host build + unit tests (SPS parser, live feeder, pacer,
#                 NV12->I420, MGVF writer; NAL reader from idrive-apps' waze-on-cluster),
#                 then the smoke test (make smoke)
#   make smoke    host camdec with a fake decoder, real Annex-B files fed
#                 like the live server (tools/feed.py, tools/smoke.py);
#                 SMOKE_EXTRA="a.h264 b.h264" adds more files
#   make target   head-unit binary build/target/camdec, built in Docker with
#                 the toolchain image of docker/Dockerfile (Ubuntu 18.04: gcc 7.5,
#                 glibc 2.27, x86_64) against stubs of the unit's libmfxhw64,
#                 libva and libva-drm, every import and the glibc level
#                 checked; the unit tests are built and run there too (the
#                 SSE2 converter against its scalar reference)
#
# Docker cannot mount macOS's /var/folders: export TMPDIR to the external disk
# first (a folder under your home or another disk).

CXX     ?= c++
PYTHON  ?= python3
FFMPEG  ?= ffmpeg
BUILD   ?= build
CR      ?= .
IMAGE   := cluster-render-build:$(shell cksum 2>/dev/null < $(CR)/docker/Dockerfile | cut -d' ' -f1)
DOCKER_IMAGE = docker image inspect $(IMAGE) >/dev/null 2>&1 || \
	docker build -q --platform linux/amd64 -t $(IMAGE) $(CR)/docker
VERSION := $(shell git describe --always --dirty 2>/dev/null || echo dev)

CXXFLAGS = -std=c++14 -O2 -g -Wall -Wextra -Werror -pthread
CPPFLAGS = -Isrc -Iabi/include
T = $(BUILD)/target
H = $(BUILD)/host

CORE = src/feeder.cpp src/nal_reader.cpp src/mgvf.cpp
SRC = src/main.cpp src/decoder_msdk.cpp $(CORE)
HDR = $(wildcard src/*.h)

.PHONY: all test smoke target target-in-docker clean
all: test

test: $(H)/nal_reader_test $(H)/camdec_test $(if $(shell command -v $(FFMPEG)),smoke)   # smoke needs ffmpeg
	$(H)/nal_reader_test
	$(H)/camdec_test

$(H)/nal_reader_test $(T)/nal_reader_test: test/nal_reader_test.cpp src/nal_reader.cpp src/nal_reader.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) -Isrc -o $@ test/nal_reader_test.cpp src/nal_reader.cpp

$(H)/camdec_test $(T)/camdec_test: test/camdec_test.cpp $(CORE) $(HDR)
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -o $@ test/camdec_test.cpp $(CORE)

# host camdec: main.cpp with test/fake_decoder.h instead of MSDK
$(H)/camdec: src/main.cpp $(CORE) $(HDR) test/fake_decoder.h
	mkdir -p $(@D)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -Itest -DCAMDEC_FAKE -o $@ src/main.cpp $(CORE)

# test pattern (ffmpeg testsrc); the second file changes size and rate
$(H)/smoke/x.h264:
	mkdir -p $(@D)
	$(FFMPEG) -v error -y -f lavfi -i testsrc2=s=1920x720:r=30 -t 5 -c:v libx264 -bf 0 -g 30 -x264-params repeat-headers=1 -f h264 $@
$(H)/smoke/y.h264:
	mkdir -p $(@D)
	$(FFMPEG) -v error -y -f lavfi -i testsrc2=s=1280x720:r=20 -t 2 -c:v libx264 -bf 0 -g 20 -x264-params repeat-headers=1 -f h264 $@

smoke: $(H)/camdec $(H)/smoke/x.h264 $(H)/smoke/y.h264
	$(PYTHON) -u tools/smoke.py $(H)/camdec $(H)/smoke $(H)/smoke/x.h264 $(H)/smoke/y.h264 $(SMOKE_EXTRA)

target:
	$(DOCKER_IMAGE)
	docker run --rm --platform linux/amd64 --user "$$(id -u):$$(id -g)" -v "$(CURDIR):/w" -w /w $(IMAGE) \
		make -s BUILD=$(BUILD) VERSION=$(VERSION) CXX=g++ IMAGE=- target-in-docker

target-in-docker: $(T)/camdec $(T)/camdec_test $(T)/nal_reader_test
	$(T)/nal_reader_test
	$(T)/camdec_test

$(T)/stub/libmfxhw64.so: abi/libmfx.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/mfx_stub.c
	gcc -shared -Wl,-soname,libmfxhw64.so -o $@ $(@D)/mfx_stub.c

$(T)/stub/libva.so.1: abi/libva.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/va_stub.c
	gcc -shared -Wl,-soname,libva.so.1 -o $@ $(@D)/va_stub.c

$(T)/stub/libva-drm.so.1: abi/libva-drm.symbols
	mkdir -p $(@D)
	$(PYTHON) tools/ramses_abi.py stub-source $< > $(@D)/va_drm_stub.c
	gcc -shared -Wl,-soname,libva-drm.so.1 -o $@ $(@D)/va_drm_stub.c

STUBS = $(T)/stub/libmfxhw64.so $(T)/stub/libva.so.1 $(T)/stub/libva-drm.so.1

# -DNDEBUG: no assert may abort (and dump) on the unit (as in Moonride)
$(T)/camdec: $(SRC) $(HDR) $(STUBS)
	mkdir -p $(@D)
	g++ $(CXXFLAGS) $(CPPFLAGS) -DNDEBUG -DCAMDEC_VERSION='"$(VERSION)"' \
		-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2 -o $@ $(SRC) $(STUBS)
	$(PYTHON) tools/abi.py check $@ abi/libvsomeip3.so.3.symbols   # loader, glibc/libstdc++ limits
	$(PYTHON) tools/woc_abi.py check-imports $@ --prefix MFX va -- \
		abi/libmfx.symbols abi/libva.symbols abi/libva-drm.symbols

clean:
	rm -rf $(BUILD)
