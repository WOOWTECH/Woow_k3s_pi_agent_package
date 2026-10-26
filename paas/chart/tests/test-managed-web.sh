#!/usr/bin/env bash
# No Kubernetes: exercise the real rendered auth proxy with a local HTTP fixture.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$HERE/test-managed-web.py"
