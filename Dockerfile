# syntax=docker/dockerfile:1
#
# Woow k3s Pi Agent — image for running pi-web + the pi coding agent TUI on
# Kubernetes.
#
# CI builds this with docker/build-push-action (buildx), which produces a
# Docker-format image and honours the SHELL instruction below. A LOCAL build
# with podman must pass --format=docker for the same reason:
#
#   podman build --format=docker -t woow-k3s-pi-agent:dev -f Dockerfile .
#
# The OCI image format has no field for SHELL, so buildah's default OCI output
# silently drops it and every `RUN set -euo pipefail` in this file then runs
# under dash:
#
#   /bin/sh: 1: set: Illegal option -o pipefail
#
# which fails the build at a step that has nothing to do with the real problem.
#
# Derived from WOOWTECH/Woow_ha_pi_agent_add_on's Dockerfile, with the Home
# Assistant layer removed:
#   - base is plain debian:bookworm-slim, not hassio-addons/debian-base
#     (no s6-overlay supervisor: on k8s the kubelet is the supervisor, and one
#     process per container is the whole point)
#   - no bashio: options come from the Helm chart as env vars, not from the
#     Supervisor's options.json
#   - no Supervisor sidebar POST, no ingress prefix shim
# and three things added:
#   - `pi` on PATH. Upstream ships @earendil-works/pi-coding-agent only as a
#     TRANSITIVE dep of @agegr/pi-web, so npm never links its `pi` bin. Without
#     the wrapper below, `pi` is command-not-found inside the container and no
#     terminal workflow can drive the agent's TUI at all.
#   - ttyd, baked in. The previous k3s deploy downloaded ttyd + kubectl from
#     GitHub on every container start; that makes pod startup depend on
#     github.com being reachable and on apt mirrors being healthy. Baked.
#     As of pi-web 0.9.0 the UI has its own browser terminal and the chart
#     defaults `ttyd.enabled=false`, but the binary stays in the image so
#     re-enabling it is a values flip and not a rebuild.
#   - the CJK path patch. This was carried by the Podman sibling and by the
#     add-on, but never by this image — an inconsistency, not a decision. See
#     the patch stage below.


# =============================================================================
# Stage 1 — build pi-web (and compile node-pty) in a throwaway toolchain image.
# =============================================================================
#
# WHY A BUILDER STAGE EXISTS AS OF pi-web 0.9.0
#
# 0.9.0 added a browser terminal, and with it a hard dependency on node-pty,
# which is a native addon. node-pty 1.1.0 ships prebuilt binaries for darwin
# and win32 ONLY — there is no linux-x64 or linux-arm64 prebuild — so its
# install script falls through to `node-gyp rebuild`:
#
#     install: "node scripts/prebuild.js || node-gyp rebuild"
#
# Measured against the 0.8.4 runtime image, which has neither make nor g++:
#
#     gyp ERR! build error
#     gyp ERR! stack Error: not found: make
#     gyp ERR! not ok
#
# So a compiler is now REQUIRED to build this image. It is not required to run
# it, and this pod is by design an arbitrary-code-execution engine — shipping
# a full toolchain inside it is exactly the sort of thing an escaped agent
# would enjoy finding. The toolchain therefore lives here and only the
# finished tree is copied forward.
#
# Both stages install nodejs from the same node_22.x NodeSource suite in the
# same build, and the runtime stage re-requires the module as a build-time
# assertion, so an ABI mismatch fails the build instead of surfacing as a
# terminal that attaches and never prompts.
FROM debian:bookworm-slim AS piweb-builder

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    npm_config_cache=/tmp/npm-cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    DEBIAN_FRONTEND=noninteractive

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg build-essential python3 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# pi-web ships a pre-built .next/ in the npm tarball, and pulls
# @earendil-works/pi-coding-agent in as a library — there is no separate agent
# daemon to run.
#
# Pinned deliberately. Upstream moves fast and pi-web's own Host/Origin trust
# guard and /api/* route surface are what the nginx sidecar is written
# against. Bump this ARG only after re-running the acceptance suite.
#
# 0.9.0 notes, both read out of the built middleware.js rather than release
# notes:
#   - the guard's matcher widened from "/api/:path*" to ["/", "/api/:path*"],
#     so the HTML entry point is host-checked too and answers a PLAIN-TEXT
#     403 "Untrusted request". No effect through the nginx sidecar, which
#     rewrites Host for the whole `location /` — but it is the first thing to
#     suspect if a future proxy change breaks the UI.
#   - PI_WEB_PASSWORD enables built-in HTTP Basic Auth (username "pi").
#     The chart exposes this as piWeb.password; see values.yaml.
ARG PI_WEB_VERSION=0.9.0
RUN npm install -g --omit=dev --prefix=/opt/piweb "@agegr/pi-web@${PI_WEB_VERSION}" \
    && rm -rf /tmp/npm-cache

# node-gyp can fail in ways npm does not treat as fatal, and a missing
# pty.node becomes a terminal that opens and immediately dies at runtime.
# Assert the artifact exists and loads, here, where the failure is a red build.
RUN set -euo pipefail; \
    PTY="/opt/piweb/lib/node_modules/@agegr/pi-web/node_modules/node-pty"; \
    test -f "${PTY}/build/Release/pty.node" \
      || { echo "[build] FAIL: node-pty was not compiled for linux" >&2; exit 1; }; \
    node -e 'const p=require(process.argv[1]); if (typeof p.spawn !== "function") { throw new Error("node-pty loaded but has no spawn()"); } console.log("[build] node-pty OK");' "${PTY}"

# Stop silent CJK path corruption.
#
# Upstream folds U+3000 and other Unicode spaces to ASCII on every read, write
# and edit, and builds the read fallback chain from the folded path — so a
# write to `台灣　報告.txt` lands at `台灣 報告.txt` while reporting success,
# and two files differing only by space type cross-read. U+3000 IDEOGRAPHIC
# SPACE is ordinary in Traditional Chinese filenames, so for this deployment
# that is data loss with a success message.
#
# Carried by the Podman sibling and the HA add-on since day one; this image
# went without it, which was an oversight rather than a decision. Still
# unfixed upstream at pi-coding-agent 0.85.1.
#
# The patch asserts every hunk, so an upstream bump fails the build rather
# than shipping an image that quietly lost the fix.
COPY patches/ /opt/patches/
RUN set -euo pipefail; \
    mapfile -d '' FILES < <(find /opt/piweb/lib/node_modules/@agegr/pi-web \
      -path '*@earendil-works/*/dist/*/tools/path-utils.js' -print0); \
    echo "[patch] found ${#FILES[@]} path-utils.js copies"; \
    if [ "${#FILES[@]}" -lt 2 ]; then \
      echo "[patch] FAIL: expected at least 2 copies, found ${#FILES[@]}" >&2; \
      exit 1; \
    fi; \
    node /opt/patches/fix-unicode-space-paths.mjs "${FILES[@]}"


# =============================================================================
# Stage 2 — the runtime image. No compiler, no npm registry access.
# =============================================================================
FROM debian:bookworm-slim

ENV LANG=C.UTF-8 \
    NODE_ENV=production \
    npm_config_cache=/tmp/npm-cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PI_TELEMETRY=0 \
    PI_SKIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Runtime deps. Rationale per group (kept from the add-on, which learned these
# the hard way — see that repo's CHANGELOG):
#   ca-certificates curl git gnupg jq openssh-client — provider self-check,
#     models.json merges, and the `skills` CLI which shells out to git/ssh.
#   tini — PID 1 reaping. Both ttyd and pi-web 0.9.0's built-in terminal fork
#     a shell per browser session; without an init that reaps, every closed
#     tab leaves a zombie.
#   python3/venv/pip, ffmpeg, fonts-noto-* , chromium .so set, rclone —
#     the video pipeline. fonts-noto-cjk is not optional: nothing else in
#     Debian covers CJK glyphs for libass subtitle burn.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git gnupg jq openssh-client tini procps less vim-tiny \
       python3 python3-venv python3-pip \
       ffmpeg \
       fonts-noto-cjk fonts-noto-color-emoji fontconfig \
       libnss3 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
       libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
       | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
       > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && ARCH="$(dpkg --print-architecture)" \
    && curl -fsSL "https://downloads.rclone.org/rclone-current-linux-${ARCH}.deb" -o /tmp/rclone.deb \
    && dpkg -i /tmp/rclone.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# ttyd — static binary from upstream releases, checksum-verified against the
# release's own SHA256SUMS. Pinned: 1.7.7 is the current stable tag.
#
# Retained even though the chart now defaults ttyd.enabled=false: keeping the
# binary makes re-enabling the sidecar a values flip rather than a rebuild,
# and it costs ~1MB. See the chart's values.yaml for why the default moved.
ARG TTYD_VERSION=1.7.7
RUN set -euo pipefail; \
    case "$(dpkg --print-architecture)" in \
      amd64)  TARCH=x86_64  ;; \
      arm64)  TARCH=aarch64 ;; \
      *) echo "unsupported arch for ttyd: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}"; \
    curl -fsSL -o /usr/local/bin/ttyd "${base}/ttyd.${TARCH}"; \
    curl -fsSL -o /tmp/SHA256SUMS "${base}/SHA256SUMS"; \
    expected="$(awk -v f="ttyd.${TARCH}" '$2==f || $2=="*"f {print $1}' /tmp/SHA256SUMS)"; \
    actual="$(sha256sum /usr/local/bin/ttyd | awk '{print $1}')"; \
    if [ -z "${expected}" ] || [ "${expected}" != "${actual}" ]; then \
      echo "ttyd checksum mismatch: expected='${expected}' actual='${actual}'" >&2; exit 1; \
    fi; \
    chmod +x /usr/local/bin/ttyd; \
    rm -f /tmp/SHA256SUMS; \
    /usr/local/bin/ttyd --version

# The finished, patched pi-web tree from stage 1. `npm install -g --prefix`
# put it under /opt/piweb/{lib,bin}, so it lands at /usr/local unchanged and
# the `pi-web` bin stays a working RELATIVE symlink into lib/node_modules.
COPY --from=piweb-builder /opt/piweb/lib/node_modules /usr/local/lib/node_modules
COPY --from=piweb-builder /opt/piweb/bin              /usr/local/bin

COPY rootfs/ /

RUN chmod +x /usr/local/bin/pi \
             /usr/local/bin/pi-web-start.sh \
             /usr/local/bin/pi-shell.sh \
             /usr/local/bin/ttyd-start.sh \
             /usr/local/bin/video-tools-init.sh \
    && test -x "$(command -v pi)" \
    && pi --version \
    # Cross-stage ABI assertion: stage 1 compiled pty.node against ITS nodejs,
    # and this is the first moment the module is asked to load under the
    # nodejs that will actually run it.
    && node -e 'const p=require("/usr/local/lib/node_modules/@agegr/pi-web/node_modules/node-pty"); if (typeof p.spawn !== "function") { throw new Error("node-pty has no spawn()"); } console.log("[build] node-pty loads under the runtime node");'

ARG BUILD_VERSION=dev
ARG BUILD_REF=unknown
ARG BUILD_DATE=unknown
ARG PI_WEB_VERSION=0.9.0

ENV PI_AGENT_IMAGE_VERSION=${BUILD_VERSION} \
    PI_WEB_VERSION=${PI_WEB_VERSION} \
    TTYD_VERSION=${TTYD_VERSION}

# SHELL is what pi-web 0.9.0's browser terminal spawns:
#     process.env.SHELL || "/bin/sh"   with argv ["-l"]
# Debian's /bin/sh is dash, so leaving SHELL unset hands every browser
# terminal session a shell with no history, no completion and no arrays —
# while still appearing to work. Set on the image rather than in the chart so
# it is true for the pi-web process, which is what reads it.
ENV SHELL=/bin/bash

LABEL org.opencontainers.image.title="Woow k3s Pi Agent" \
      org.opencontainers.image.description="pi-web + pi coding agent, packaged for k3s" \
      org.opencontainers.image.vendor="WOOWTECH" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/WOOWTECH/Woow_k3s_pi_agent_package" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/pi-web-start.sh"]
