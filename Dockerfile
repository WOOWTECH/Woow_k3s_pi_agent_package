# syntax=docker/dockerfile:1
#
# Woow k3s Pi Agent — image for running pi-web + the pi coding agent TUI + ttyd
# on Kubernetes.
#
# Derived from WOOWTECH/Woow_ha_pi_agent_add_on's Dockerfile, with the Home
# Assistant layer removed:
#   - base is plain debian:bookworm-slim, not hassio-addons/debian-base
#     (no s6-overlay supervisor: on k8s the kubelet is the supervisor, and one
#     process per container is the whole point)
#   - no bashio: options come from the Helm chart as env vars, not from the
#     Supervisor's options.json
#   - no Supervisor sidebar POST, no ingress prefix shim
# and two things added:
#   - `pi` on PATH. Upstream ships @earendil-works/pi-coding-agent only as a
#     TRANSITIVE dep of @agegr/pi-web, so npm never links its `pi` bin. Without
#     the wrapper below, `pi` is command-not-found inside the container and the
#     browser terminal cannot drive the agent's TUI at all.
#   - ttyd, baked in. The previous k3s deploy downloaded ttyd + kubectl from
#     GitHub on every container start; that makes pod startup depend on
#     github.com being reachable and on apt mirrors being healthy. Baked.
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
#   tini — PID 1 reaping. ttyd forks a shell per browser session; without an
#     init that reaps, every closed tab leaves a zombie.
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

# pi-web ships a pre-built .next/ in the npm tarball, and pulls
# @earendil-works/pi-coding-agent in as a library — there is no separate agent
# daemon to run.
#
# Pinned deliberately. 0.8.4 is the version the HA add-on validated end to end;
# upstream moves fast and pi-web's own Host/Origin trust guard and /api/* route
# surface are what the nginx sidecar is written against. Bump this ARG only
# after re-running the acceptance suite.
ARG PI_WEB_VERSION=0.8.4
RUN npm install -g --omit=dev "@agegr/pi-web@${PI_WEB_VERSION}" \
    && rm -rf /tmp/npm-cache

# Fix silent CJK path corruption in the shipped tool layer. Upstream folds
# U+3000 and other Unicode spaces to ASCII on every read/write/edit and builds
# the read fallback chain from the folded path, so writes land at the wrong
# name while reporting success, and two files differing only by space type
# cross-read. See patches/fix-unicode-space-paths.mjs for the full rationale.
#
# The assertion matters as much as the patch: if a pi-web bump moves or rewrites
# these files, this step fails the build instead of shipping an image that
# quietly lost the fix.
COPY patches/ /opt/patches/
RUN set -euo pipefail; \
    mapfile -d '' FILES < <(find /usr/lib/node_modules/@agegr/pi-web \
      -path '*@earendil-works/*/dist/*/tools/path-utils.js' -print0); \
    echo "[patch] found ${#FILES[@]} path-utils.js copies"; \
    if [ "${#FILES[@]}" -lt 2 ]; then \
      echo "[patch] FAIL: expected at least 2 copies, found ${#FILES[@]}" >&2; \
      echo "[patch] upstream layout changed — re-verify before shipping" >&2; \
      exit 1; \
    fi; \
    node /opt/patches/fix-unicode-space-paths.mjs "${FILES[@]}"

COPY rootfs/ /

RUN chmod +x /usr/local/bin/pi \
             /usr/local/bin/pi-web-start.sh \
             /usr/local/bin/pi-shell.sh \
             /usr/local/bin/ttyd-start.sh \
             /usr/local/bin/video-tools-init.sh \
    && test -x "$(command -v pi)" \
    && pi --version

ARG BUILD_VERSION=dev
ARG BUILD_REF=unknown
ARG BUILD_DATE=unknown

ENV PI_AGENT_IMAGE_VERSION=${BUILD_VERSION} \
    PI_WEB_VERSION=${PI_WEB_VERSION} \
    TTYD_VERSION=${TTYD_VERSION}

LABEL org.opencontainers.image.title="Woow k3s Pi Agent" \
      org.opencontainers.image.description="pi-web + pi coding agent + ttyd, packaged for k3s" \
      org.opencontainers.image.vendor="WOOWTECH" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/WOOWTECH/Woow_k3s_pi_agent_package" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/pi-web-start.sh"]
