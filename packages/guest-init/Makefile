# Cross-compile the guest-init binaries (init + idle-agent) as static
# musl-linked executables. Static linking is required because these run
# inside minimal microVM rootfs images where shared libraries may not
# exist. The built binaries are injected into the rootfs by
# @boilerhouse/build's injectInit() at /opt/boilerhouse/{init,idle-agent}.
#
# Targets:
#   make            — build x86_64 (default)
#   make x86_64     — build for x86_64
#   make aarch64    — build for aarch64 (requires cross-compiler)
#   make clean      — remove build/

CC_x86_64  := x86_64-linux-musl-gcc
CC_aarch64 := aarch64-linux-musl-gcc

CFLAGS := -O2 -Wall -Wextra -Werror -static -std=c11

SRCS_INIT       := src/main.c
SRCS_IDLE_AGENT := idle-agent/main.c

.PHONY: all x86_64 aarch64 clean check-cc-x86_64 check-cc-aarch64

all: x86_64

# --- x86_64 ---

x86_64: check-cc-x86_64 build/x86_64/init build/x86_64/idle-agent

check-cc-x86_64:
	@command -v $(CC_x86_64) >/dev/null 2>&1 || \
		{ echo "ERROR: $(CC_x86_64) not found. Install with: sudo apt install musl-tools"; exit 1; }

build/x86_64/init: $(SRCS_INIT) | build/x86_64
	$(CC_x86_64) $(CFLAGS) -o $@ $(SRCS_INIT)

build/x86_64/idle-agent: $(SRCS_IDLE_AGENT) | build/x86_64
	$(CC_x86_64) $(CFLAGS) -o $@ $(SRCS_IDLE_AGENT)

build/x86_64:
	mkdir -p $@

# --- aarch64 ---

aarch64: check-cc-aarch64 build/aarch64/init build/aarch64/idle-agent

check-cc-aarch64:
	@command -v $(CC_aarch64) >/dev/null 2>&1 || \
		{ echo "ERROR: $(CC_aarch64) not found. Install with: sudo apt install gcc-aarch64-linux-gnu musl-tools-aarch64"; exit 1; }

build/aarch64/init: $(SRCS_INIT) | build/aarch64
	$(CC_aarch64) $(CFLAGS) -o $@ $(SRCS_INIT)

build/aarch64/idle-agent: $(SRCS_IDLE_AGENT) | build/aarch64
	$(CC_aarch64) $(CFLAGS) -o $@ $(SRCS_IDLE_AGENT)

build/aarch64:
	mkdir -p $@

# --- clean ---

clean:
	rm -rf build/
