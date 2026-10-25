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
#   7. error hints and session fixes (patch-error-hints.mjs, AI-FIX-PI-3): zh-TW hints for provider 401/403,
#      empty key, full disk and small-session /compact (HTTP 409 instead of 500); a saved models-config
#      reaches sessions that are already open (#1461); a restart-interrupted tool call is closed with an
#      "interrupted" result
#   8. the passwd home of uid 1000 is the volume home ($HOME=/data/pi-agent/home), so ssh/ssh-keygen/git
#      keep keys and known_hosts across restarts (they ignore $HOME and read /etc/passwd)
# Chart: woow-paas-charts charts/pi-agent (loopback pi-web behind an nginx basic-auth
# sidecar). Registry: jcr-prod.woowtech.io/woow-paas-docker-local/pi-agent:{tag}.
ARG BASE=ghcr.io/woowtech/woow-k3s-pi-agent:0.3.2@sha256:927a947bb7ae4898ff72f46b1d3b88306b2ceba0c89965a74114c27aab2a27b6
FROM ${BASE}

ARG PI_WEB_DIR=/usr/local/lib/node_modules/@agegr/pi-web

# Omnigent writes a session-local model catalog with branded LiteLLM IDs.  Keep
# the image launcher authoritative and enrich that catalog from the canonical
# models.json on the data volume before Pi starts.
COPY sync-litellm-model-metadata.py /opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py
COPY patch-pi-context-window-launcher.py sync-litellm-model-metadata.py /opt/patches/
RUN python3 /opt/patches/patch-pi-context-window-launcher.py /usr/local/bin/pi \
    && test -r /opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py \
    && grep -q 'sync-litellm-model-metadata.py' /usr/local/bin/pi \
    && chmod 0755 /usr/local/bin/pi \
    && chmod 0644 /opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py

# Apply all PaaS route patches after the root image builds the pinned native UI.
# Resolve the session chunk by content, preflight every anchor and syntax-check
# every output before writing. The same entry point is used by the PR gate.
COPY patch-*.mjs /opt/patches/
COPY tests/ /opt/patches/tests/
RUN node --test /opt/patches/tests/*.test.mjs \
    && python3 -B /opt/patches/tests/patch-pi-context-window-launcher.test.py \
    && python3 -B /opt/patches/tests/sync-litellm-model-metadata.test.py \
    && node /opt/patches/tests/compiled-overlay-live.mjs "${PI_WEB_DIR}" \
    && node /opt/patches/patch-pi-web.mjs "${PI_WEB_DIR}" \
    && node /opt/patches/patch-pi-web.mjs "${PI_WEB_DIR}" \
    && node /opt/patches/tests/device-id-live.mjs "${PI_WEB_DIR}"

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
# The passwd home is the VOLUME home, not /home/pi (container layer): OpenSSH (ssh, ssh-keygen, git over ssh)
# resolves "~" from /etc/passwd and ignores $HOME, so with /home/pi a key generated the usual way and
# known_hosts vanished on every restart (AI-PI-003-1). pi-web-start.sh creates the directory on the volume.
RUN groupadd -g 1000 pi && useradd -u 1000 -g 1000 -M -d /data/pi-agent/home -s /bin/bash pi \
    && S=/usr/local/bin/pi-web-start.sh \
    && grep -q '^    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime$' "$S" \
    && grep -q '^    echo "${TZ}" > /etc/timezone$' "$S" \
    && sed -i \
         -e 's|^    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime$|    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null \|\| true|' \
         -e 's|^    echo "${TZ}" > /etc/timezone$|    { echo "${TZ}" > /etc/timezone; } 2>/dev/null \|\| true|' "$S" \
    && grep -q '^    ln -sf "/usr/share/zoneinfo/${TZ}" /etc/localtime 2>/dev/null || true$' "$S" \
    && grep -q '^    { echo "${TZ}" > /etc/timezone; } 2>/dev/null || true$' "$S" \
    && mkdir -p "${PI_WEB_DIR}/.next/cache" /data/pi-agent \
    && chown -R 1000:1000 "${PI_WEB_DIR}/.next/cache" /data \
    && test "$(getent passwd pi | cut -d: -f6)" = /data/pi-agent/home \
    && OUT="$(setpriv --reuid=1000 --regid=1000 --clear-groups env -u HOME ssh -vvv -o BatchMode=yes -o ConnectTimeout=1 -p 1 127.0.0.1 2>&1 || true)" \
    && echo "$OUT" | grep -q "expanded UserKnownHostsFile '~/.ssh/known_hosts' -> '/data/pi-agent/home/.ssh/known_hosts'"

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
# kit's one-host lock and process group. The Claude Agent SDK's redundant bundled
# CLI is removed; the official Claude Code and Codex distributions above remain.
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
# 4b. Claude Code's <system-reminder> blocks (CLAUDE.md, auto-memory index, task notifications) share the
# person's role=user transcript record; omnigent 0.16.0 mirrors every block, so the web chat shows a ~19 KB
# "<system-reminder> Codebase and user instructions ..." bubble and the session title is generated from it
# ("記憶索引與專案狀態"). Exact-anchor, version-gated patch (fails the build if the omnigent pin moves or the
# anchors drift); unit tests run on the patched package; pyc is rewritten because /opt is read-only at runtime.
COPY omnigent-reminder-patch/ /opt/patches/omnigent-reminder-patch/
COPY tests/omnigent-reminder-patch.test.py /opt/patches/tests/omnigent-reminder-patch.test.py
RUN set -eu; \
    SP=/opt/omnigent/venv/lib/python3.12/site-packages; \
    /opt/omnigent/venv/bin/python /opt/patches/omnigent-reminder-patch/omnigent-reminder-patch.py --site-packages "$SP" --strict; \
    /opt/omnigent/venv/bin/python /opt/patches/tests/omnigent-reminder-patch.test.py; \
    grep -q 'omnigent-reminder-patch v2' "$SP/omnigent/harnesses/claude_native/bridge.py"; \
    chmod -R a+rX,go-w /opt/omnigent
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
