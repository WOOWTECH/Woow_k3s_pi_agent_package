#!/usr/bin/env bash
# Compare this repo with what is running, release by release.
#   1. repo vs release : helm template (this chart + values/<cluster>/<release>.yaml)
#                        against `helm get manifest <release>`
#   2. pod template    : the two renders' Deployment .spec.template compared on
#                        their own, because that is the part whose difference
#                        means "an upgrade restarts the pod"
#
# The tunnel credential is never committed, so for a release that carries it
# inline this script reads it out of the live release at run time into a 0600
# temp file, passes it with --set-file, and deletes it. It is never printed.
#
#   CONTEXT=woow-k3s NAMESPACE=pi-agent-woow scripts/check-drift.sh
#   RELEASES="pi-agent pi-tunnel" scripts/check-drift.sh
#
# Exit 0 = every release in sync, 1 = drift.
set -uo pipefail

CONTEXT="${CONTEXT:-woow-k3s}"
NAMESPACE="${NAMESPACE:-pi-agent-woow}"
VALUES_DIR="${VALUES_DIR:-charts/pi-agent/values/woow-k3s}"
RELEASES="${RELEASES:-pi-agent pi-agent-2 pi-agent-3 pi-agent-4 pi-agent-5 pi-tunnel}"
cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"; chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

rc=0
for rel in $RELEASES; do
  vals="$VALUES_DIR/$rel.yaml"
  if [ ! -f "$vals" ]; then
    echo "!! $rel: no instance values at $vals"; rc=1; continue
  fi

  extra=()
  # cloudflare.credentialsJson held inline in the live release: fetch, use, drop.
  if helm --kube-context "$CONTEXT" get values "$rel" -n "$NAMESPACE" -o json 2>/dev/null \
       | grep -q '"credentialsJson"'; then
    ( umask 077
      helm --kube-context "$CONTEXT" get values "$rel" -n "$NAMESPACE" -o json \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["cloudflare"]["credentialsJson"], end="")' \
        > "$tmp/creds.json" )
    extra+=(--set-file "cloudflare.credentialsJson=$tmp/creds.json")
  fi

  if ! helm template "$rel" charts/pi-agent -n "$NAMESPACE" -f "$vals" --skip-tests \
         "${extra[@]}" > "$tmp/$rel.repo.yaml" 2>"$tmp/$rel.err"; then
    echo "!! $rel: render failed"; sed -E 's/TunnelSecret[^,}]*/TunnelSecret:<redacted>/' "$tmp/$rel.err"
    rc=1; rm -f "$tmp/creds.json"; continue
  fi
  rm -f "$tmp/creds.json"

  helm --kube-context "$CONTEXT" get manifest "$rel" -n "$NAMESPACE" > "$tmp/$rel.live.yaml"

  # -B: `helm get manifest` ends with a blank line that `helm template` does not.
  if diff -u -B "$tmp/$rel.live.yaml" "$tmp/$rel.repo.yaml" > "$tmp/$rel.diff"; then
    echo "== $rel: repo == release"
  else
    echo "== $rel: DRIFT"
    sed -E 's/(credentials\.json:).*/\1 <redacted>/; s/TunnelSecret[^,}]*/TunnelSecret:<redacted>/' "$tmp/$rel.diff"
    rc=1
  fi

  # The part that decides whether an upgrade would restart anything.
  for side in live repo; do
    python3 - "$tmp/$rel.$side.yaml" > "$tmp/$rel.$side.podtpl" <<'PY'
import sys, yaml
out = []
for d in yaml.safe_load_all(open(sys.argv[1])):
    if d and d.get("kind") in ("Deployment", "StatefulSet", "DaemonSet"):
        out.append({d["metadata"]["name"]: d["spec"]["template"]})
print(yaml.safe_dump(out, sort_keys=True, default_flow_style=False))
PY
  done
  if diff -u "$tmp/$rel.live.podtpl" "$tmp/$rel.repo.podtpl" > "$tmp/$rel.podtpl.diff"; then
    echo "   pod templates identical — an upgrade would restart nothing"
  else
    echo "   POD TEMPLATE DIFFERS — an upgrade would restart this release:"
    cat "$tmp/$rel.podtpl.diff"
    rc=1
  fi
done
exit $rc
