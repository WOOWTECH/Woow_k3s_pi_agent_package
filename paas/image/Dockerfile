# pi-agent — PaaS cloud-service image for the pi coding agent (pi-web).
#
# Thin derivative of the upstream package image (WOOWTECH/Woow_k3s_pi_agent_package,
# mirrored at woow-paas/Woow_k3s_pi_agent_package). Upstream is consumed AS-IS by
# digest; this layer only applies what the PaaS contract needs and upstream does not:
#   1. /api/models-config no longer returns provider API keys (patch-models-config.mjs)
#   2. runs as uid 1000 (upstream is root) — pi-web-start.sh's two /etc writes for TZ
#      become best-effort, everything else it touches lives on the volume
#   3. video pipeline defaults OFF (browserless replaces it on the PaaS)
# Chart: woow-paas-charts charts/pi-agent (loopback pi-web behind an nginx basic-auth
# sidecar). Registry: jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}.
ARG BASE=ghcr.io/woowtech/woow-k3s-pi-agent:0.2.1@sha256:23021a1907db2a490785dbc0308120fd344b7f4bb71d19a56ef11fa8715bfc21
FROM ${BASE}

ARG PI_WEB_DIR=/usr/local/lib/node_modules/@agegr/pi-web

# 1. redact provider keys on the models-config API (exact-anchor patch; fails the build if upstream moved)
COPY patch-models-config.mjs /opt/patches/patch-models-config.mjs
RUN node /opt/patches/patch-models-config.mjs "${PI_WEB_DIR}/.next/server/app/api/models-config/route.js" \
    && grep -q '__PI_REDACTED__' "${PI_WEB_DIR}/.next/server/app/api/models-config/route.js"

# 2. non-root: uid/gid 1000, best-effort TZ writes, writable Next cache, volume mountpoint owned
RUN groupadd -g 1000 pi && useradd -u 1000 -g 1000 -m -d /home/pi -s /bin/bash pi \
    && S=/usr/local/bin/pi-web-start.sh \
    && grep -q '^    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime$' "$S" \
    && grep -q '^    echo "${TZ}" > /etc/timezone$' "$S" \
    && sed -i \
         -e 's|^    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime$|    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null \|\| true|' \
         -e 's|^    echo "${TZ}" > /etc/timezone$|    { echo "${TZ}" > /etc/timezone; } 2>/dev/null \|\| true|' "$S" \
    && grep -q '^    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null || true$' "$S" \
    && grep -q '^    { echo "${TZ}" > /etc/timezone; } 2>/dev/null || true$' "$S" \
    && mkdir -p "${PI_WEB_DIR}/.next/cache" /data/pi-agent \
    && chown -R 1000:1000 "${PI_WEB_DIR}/.next/cache" /data

# 3. PaaS defaults (the chart sets these explicitly too; belt and braces)
ENV VIDEO_PIPELINE_ENABLED=false \
    PI_WEB_HOSTNAME=127.0.0.1
USER 1000:1000
