# pi-agent — PaaS cloud-service image for the pi coding agent (pi-web).
#
# Thin derivative of the upstream package image (WOOWTECH/Woow_k3s_pi_agent_package,
# mirrored at woow-paas/Woow_k3s_pi_agent_package). Upstream is consumed AS-IS by
# digest; this layer only applies what the PaaS contract needs and upstream does not:
#   1. /api/models-config no longer returns provider API keys (patch-models-config.mjs)
#   2. runs as uid 1000 (upstream is root) — pi-web-start.sh's two /etc writes for TZ
#      become best-effort, everything else it touches lives on the volume
#   3. video pipeline defaults OFF (browserless replaces it on the PaaS)
#   4. the omnigent CLI (hash-locked, Python 3.12) + tmux >= 3.3 + a pi-web terminal
#      hook, so the tenant can `omnigent login <url>` in pi-web's terminal and the
#      chart's omnigent-host kit (launcher + supervisor from a ConfigMap, NOT in this
#      image) keeps this pi-agent online as an Omnigent host, running inside the pi-web
#      container next to pi-web (no sidecar)
#   5. an office/PDF toolbox for pi (QA round 1, PA-02): `python` (python-is-python3),
#      python3-docx, python3-openpyxl, python3-pypdf, python3-reportlab, poppler-utils,
#      plus a CJK font reportlab can embed: fonts-wqy-microhei (TrueType outlines; the
#      base's Noto CJK fonts are CFF, which reportlab refuses)
#   6. sending with no model or no provider key answers with a zh-TW hint pointing at
#      pi-web's "模型" button instead of pi's TUI "/login" text (patch-prompt-errors.mjs)
# Chart: woow-paas-charts charts/pi-agent (loopback pi-web behind an nginx basic-auth
# sidecar). Registry: jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}.
ARG BASE=ghcr.io/woowtech/woow-k3s-pi-agent:0.2.4@sha256:32f83c2932003c7e5b24f40133011028d06bcfd919c420cb88e23f2822be6df6
FROM ${BASE}

ARG PI_WEB_DIR=/usr/local/lib/node_modules/@agegr/pi-web

# 1. redact provider keys on the models-config API (exact-anchor patch; fails the build if upstream moved)
COPY patch-models-config.mjs /opt/patches/patch-models-config.mjs
RUN node /opt/patches/patch-models-config.mjs "${PI_WEB_DIR}/.next/server/app/api/models-config/route.js" \
    && grep -q '__PI_REDACTED__' "${PI_WEB_DIR}/.next/server/app/api/models-config/route.js"

# 6. no-model / no-key prompt errors become a zh-TW hint naming pi-web's "模型" button (#1357;
#    exact-anchor patch on the compiled /api/agent/new and /api/agent/[id] routes)
COPY patch-prompt-errors.mjs /opt/patches/patch-prompt-errors.mjs
RUN node /opt/patches/patch-prompt-errors.mjs \
      "${PI_WEB_DIR}/.next/server/app/api/agent/new/route.js" \
      "${PI_WEB_DIR}/.next/server/app/api/agent/[id]/route.js" \
    && grep -q '__piPromptHint' "${PI_WEB_DIR}/.next/server/app/api/agent/new/route.js" \
    && grep -q '__piPromptHint' "${PI_WEB_DIR}/.next/server/app/api/agent/[id]/route.js"

# ChatGPT OAuth now requires a stable installation UUID via login options.
COPY patch-chatgpt-device-id.mjs /opt/patches/patch-chatgpt-device-id.mjs
COPY tests/chatgpt-device-id.test.mjs /opt/patches/tests/chatgpt-device-id.test.mjs
COPY tests/device-id-live.mjs /opt/patches/tests/device-id-live.mjs
RUN node --test /opt/patches/tests/chatgpt-device-id.test.mjs \
    && node /opt/patches/tests/device-id-live.mjs \
    && node /opt/patches/patch-chatgpt-device-id.mjs "${PI_WEB_DIR}/.next/server/app/api/auth/login/[provider]/route.js" \
    && node --check "${PI_WEB_DIR}/.next/server/app/api/auth/login/[provider]/route.js"

# Official CLI distributions are baked into every new Pi instance. Exact npm
# versions/integrities are locked; tenant HOME contains only login/user state.
COPY cli-runtime/package.json cli-runtime/package-lock.json /opt/pi-clis/
RUN npm ci --omit=dev --prefix /opt/pi-clis \
    && ln -s /opt/pi-clis/node_modules/.bin/claude /usr/local/bin/claude \
    && ln -s /opt/pi-clis/node_modules/.bin/codex /usr/local/bin/codex \
    && claude --version | grep -q '^2.1.296' \
    && codex --version | grep -q '0.162.1' \
    && chmod -R a+rX,go-w /opt/pi-clis

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

# 4. omnigent CLI only. The launcher, supervisor, helper, `omnigent` guard and status
# printer come from the chart (woow-paas-charts shared/omnigent-host, mounted from a
# ConfigMap at /etc/omnigent-host; the chart runs tini -> launcher -> pi-web-start.sh) —
# never baked here. Login tokens, host identity (config.yaml host_id/name) and logs live in
# $HOME/.omnigent on the volume (HOME=/data/pi-agent/home via pi-agent-env.sh), the
# same place a by-hand install wrote them, so an existing host keeps its id and login.
# Reproducible: uv (release sha256) installs a pinned uv-managed CPython (the base is
# Debian 12 / Python 3.11) and `uv pip sync --require-hashes` installs exactly the
# hash-locked omnigent-requirements.lock into /opt/omnigent/venv, bytecode compiled at
# build (/opt is read-only at runtime, so nothing recompiles per start). uv itself is
# not kept. tmux comes from the digest-pinned base (Debian 12: 3.3a) and is asserted
# >= 3.3 (the native pi harness needs it), as are flock/setsid (util-linux) for the
# kit's one-host lock and process group. This image ships no Claude Code: the Claude
# Agent SDK's bundled 200 MB CLI is removed (pi-agent offers Omnigent's Pi harness).
# The cluster's github.com downloads get reset mid-stream, hence the retries.
ARG UV_VERSION=0.12.20
ARG UV_SHA256=6590717592ace991ff83a63fef799e3ad9d33ecc8f96c5d6bdd732496e79337f
ARG OMNIGENT_PYTHON=3.12.14
ARG OMNIGENT_VERSION=0.16.0
COPY omnigent-requirements.lock /opt/omnigent/requirements.lock
COPY omnigent-terminal.sh /etc/woow/omnigent-terminal.sh
RUN set -eu; \
    export UV_PYTHON_INSTALL_DIR=/opt/omnigent/python UV_PYTHON_PREFERENCE=only-managed \
           UV_NO_CACHE=1 UV_COMPILE_BYTECODE=1 UV_HTTP_RETRIES=8 UV_HTTP_TIMEOUT=120 \
           OMNIGENT_CONFIG_HOME=/tmp/og OMNIGENT_DATA_DIR=/tmp/og OMNIGENT_ANALYTICS=0 DO_NOT_TRACK=1; \
    curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 -o /tmp/uv.tar.gz \
      "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz"; \
    echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum -c -; \
    tar xzf /tmp/uv.tar.gz -C /tmp; \
    UV=/tmp/uv-x86_64-unknown-linux-gnu/uv; \
    "$UV" --version | grep -q "^uv ${UV_VERSION}"; \
    "$UV" python install --no-bin "${OMNIGENT_PYTHON}"; \
    "$UV" venv --python "${OMNIGENT_PYTHON}" /opt/omnigent/venv; \
    "$UV" pip sync --python /opt/omnigent/venv/bin/python --require-hashes /opt/omnigent/requirements.lock; \
    "$UV" pip check --python /opt/omnigent/venv/bin/python; \
    PY=/opt/omnigent/venv/bin/python; \
    "$PY" -c "import sys; assert sys.version.split()[0] == '${OMNIGENT_PYTHON}', sys.version"; \
    SDK=$("$PY" -c "import claude_agent_sdk, os; print(os.path.dirname(claude_agent_sdk.__file__))"); \
    test -d "$SDK"; \
    rm -f "$SDK/_bundled/claude"; \
    test -z "$(find "$SDK" -type f -size +10M)"; \
    ln -sf /opt/omnigent/venv/bin/omnigent /usr/local/bin/omnigent; \
    omnigent --version 2>&1 | grep -q "${OMNIGENT_VERSION}" || { omnigent --version; exit 1; }; \
    "$PY" -c "import omnigent, omnigent.cli_auth, yaml, httpx"; \
    test -n "$(find /opt/omnigent/venv/lib/python3.12/site-packages/omnigent/__pycache__ -name 'cli_auth.cpython-312.pyc')"; \
    rm -rf /tmp/og /tmp/uv-x86_64-unknown-linux-gnu /tmp/uv.tar.gz; \
    chmod -R a+rX,go-w /opt/omnigent; \
    tmux -V | grep -Eq '^tmux (3\.([3-9]|[1-9][0-9])|[4-9][0-9]*\.)' || { tmux -V; exit 1; }; \
    command -v flock setsid git >/dev/null; \
    test -f /etc/bash.bashrc; \
    printf '\n# WOOW PaaS: Omnigent (pi-web terminal hook)\n[ -r /etc/woow/omnigent-terminal.sh ] && . /etc/woow/omnigent-terminal.sh\n' >> /etc/bash.bashrc; \
    chmod 0644 /etc/woow/omnigent-terminal.sh; \
    bash -n /etc/woow/omnigent-terminal.sh
# 5. office/PDF toolbox for pi's tools and skills (QA round 1, PA-02: pi had to improvise
# without them). Debian 12 packages, top-level versions pinned (the base is digest-pinned;
# a Debian point/security release that drops one of these versions fails the build here
# and the pin is bumped deliberately). Verified by doc-tools-check.py in the workflow,
# including a zh-TW PDF with the WenQuanYi font embedded (reportlab's built-in CID fonts
# such as MSung-Light are NOT embedded: viewers without CJK fonts and pdftotext cannot read them).
# A tenant's pi writes Chinese PDFs with reportlab's
# TTFont("WQY", "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", subfontIndex=0).
ARG DOC_TOOLS="python-is-python3=3.11.2-1+deb12u1 python3-docx=0.8.11+dfsg1-5 python3-openpyxl=3.0.9-1 python3-pypdf=3.4.1-1+deb12u1 python3-reportlab=3.6.12-1+deb12u1 poppler-utils=22.12.0-2+deb12u3 fonts-wqy-microhei=0.2.0-beta-3.1"
# hadolint ignore=DL3008
RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends ${DOC_TOOLS}; \
    rm -rf /var/lib/apt/lists/*; \
    python --version; python -c "import docx, openpyxl, pypdf, reportlab"; pdftotext -v 2>&1 | head -n1
ENV OMNIGENT_CONFIG_HOME=/data/pi-agent/home/.omnigent \
    OMNIGENT_DATA_DIR=/data/pi-agent/home/.omnigent \
    OMNIGENT_ANALYTICS=0 \
    DO_NOT_TRACK=1 \
    DISABLE_TELEMETRY=1

# 3. PaaS defaults (the chart sets these explicitly too; belt and braces)
ENV VIDEO_PIPELINE_ENABLED=false \
    PI_WEB_HOSTNAME=127.0.0.1
USER 1000:1000
