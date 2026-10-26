# PR-only overlay gate. Never pushed. Same patch transaction as the release image.
ARG BASE
FROM ${BASE}
ARG PI_WEB_DIR=/usr/local/lib/node_modules/@agegr/pi-web
COPY patch-*.mjs patch-pi-context-window-launcher.py sync-litellm-model-metadata.py /opt/patches/
COPY sync-litellm-model-metadata.py /opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py
COPY tests/ /opt/patches/tests/
RUN python3 -B /opt/patches/tests/patch-pi-context-window-launcher.test.py \
    && python3 -B /opt/patches/tests/image-launcher.test.py \
    && python3 -B /opt/patches/tests/sync-litellm-model-metadata.test.py \
    && python3 /opt/patches/patch-pi-context-window-launcher.py /usr/local/bin/pi \
    && python3 /opt/patches/patch-pi-context-window-launcher.py /usr/local/bin/pi \
    && node --test /opt/patches/tests/*.test.mjs \
    && node /opt/patches/tests/compiled-overlay-live.mjs "${PI_WEB_DIR}" \
    && node /opt/patches/patch-pi-web.mjs "${PI_WEB_DIR}" \
    && node /opt/patches/patch-pi-web.mjs "${PI_WEB_DIR}" \
    && node /opt/patches/tests/device-id-live.mjs "${PI_WEB_DIR}" \
    && HOME=/tmp/e2e-home node /opt/patches/tests/e2e/run.mjs "${PI_WEB_DIR}" \
    && HOME=/tmp/e2e-home node /opt/patches/tests/e2e/native-ui.mjs "${PI_WEB_DIR}"

# Exercise the actual protected client route as the PaaS runtime identity, not root.
USER 1000:1000
RUN HOME=/tmp/managed-web-home node /opt/patches/tests/e2e/managed-web.mjs "${PI_WEB_DIR}"
RUN python3 -B /opt/patches/tests/image-launcher.py
