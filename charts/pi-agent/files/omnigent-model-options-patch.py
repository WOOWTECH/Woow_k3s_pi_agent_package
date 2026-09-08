#!/usr/bin/env python3
"""Give Omnigent's pre-launch Pi model picker something to list.

Omnigent's "Configure Pi" dialog asks the host for the models a Pi session may
start with. Upstream `pi_native_model_options()` answers from the *managed*
provider that `omni setup` writes; when Pi is signed in with its own ambient
login instead — which is what a ChatGPT/Codex subscription is — that resolver
returns None and the function returns an empty list. The dialog then offers
only "Default" and the user cannot pick a model at all.

The installed Pi CLI already knows the answer (`pi --list-models`), so this
patch routes the None case there instead of giving up.

Why a runtime patch and not a chart value or an image layer: omnigent is
`uv tool install`-ed into $HOME, which is on the PVC, so nothing in the image
can carry it, and upstream exposes no hook for this. Applying it on every pod
start is what keeps it from being lost — including after `uv tool upgrade`.

It is deliberately unconditional-but-idempotent: it REPLACES both functions
with the canonical text below rather than only filling in a missing one, so a
fleet that has accumulated divergent hand-edits converges. Guards:

  * a version gate — patch only the omnigent release this was validated
    against, so a future release that fixes this upstream (or moves the code)
    is left alone and reported instead of silently re-patched;
  * the pristine file is kept as `.orig` on first run;
  * the result must parse and must still define both functions, or the
    original is put back.

It never fails the pod: every abnormal path logs and exits 0.
"""

from __future__ import annotations

import argparse
import ast
import glob
import os
import shutil
import sys

# Lifted verbatim from the build already proven in this fleet. Keep it in sync
# with EXPECTED_VERSION: it reuses module globals (`subprocess`, `_LOGGER`,
# `resolve_pi_native_provider`) that upstream is free to rename between
# releases, which is exactly what the version gate protects.
CANONICAL = '''\
def pi_native_model_options() -> list[dict[str, object]]:
    """Return the models that a native Pi session can select before launch.

    Managed Omnigent providers supply their own generated ``models.json``.
    When Pi uses its ambient login instead (including the ``pi`` subscription
    provider), ask the installed Pi CLI for its authenticated catalog.  The
    returned provider-qualified ids can be passed back to ``pi --model``
    verbatim when the terminal launches.
    """
    provider = resolve_pi_native_provider()
    if provider is None:
        return _ambient_pi_model_options()

    options: dict[str, dict[str, object]] = {}
    for provider_id, payload in provider.to_models_config()["providers"].items():
        for model in payload["models"]:
            model_id = model["id"]
            qualified = f"{provider_id}/{model_id}"
            options[qualified] = {
                "id": qualified,
                "model": qualified,
                "displayName": model.get("name") or model_id,
            }
    return [options[model_id] for model_id in sorted(options)]


def _ambient_pi_model_options() -> list[dict[str, object]]:
    """List models exposed by Pi's own configured providers, without launching one."""
    try:
        result = subprocess.run(
            ["pi", "--list-models"],
            capture_output=True,
            text=True,
            # `pi --list-models` measures ~5s idle on these hosts, and the
            # first minute after a pod start is not idle — 15s (upstream's
            # value) expired there and handed the dialog an empty picker,
            # which is the very failure this patch exists to remove.
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        _LOGGER.info("pi-native: could not run `pi --list-models` for the model picker")
        return []
    if result.returncode != 0:
        _LOGGER.info("pi-native: `pi --list-models` failed; leaving the model picker empty")
        return []

    options: dict[str, dict[str, object]] = {}
    for line in result.stdout.splitlines():
        columns = line.split()
        # Pi's stable table begins ``provider model context ...``.  Ignore the
        # header, separators, and any future non-tabular diagnostic lines.
        if len(columns) < 2 or columns[0] == "provider" or columns[0].startswith("-"):
            continue
        provider_id, model_id = columns[:2]
        qualified = f"{provider_id}/{model_id}"
        options[qualified] = {
            "id": qualified,
            "model": qualified,
            "displayName": model_id,
        }
    return [options[model_id] for model_id in sorted(options)]
'''

TARGETS = ("pi_native_model_options", "_ambient_pi_model_options")


def log(msg: str) -> None:
    print(f"[omnigent-model-options-patch] {msg}", flush=True)


def find_site_packages(tool_dir: str) -> str | None:
    """Return omnigent's site-packages, whichever CPython uv built the env on."""
    hits = sorted(glob.glob(os.path.join(tool_dir, "lib", "python3.*", "site-packages")))
    return hits[-1] if hits else None


def installed_version(site_packages: str) -> str | None:
    for path in glob.glob(os.path.join(site_packages, "omnigent-*.dist-info")):
        name = os.path.basename(path)
        return name[len("omnigent-") : -len(".dist-info")]
    return None


def spans(source: str) -> dict[str, tuple[int, int]]:
    """Map each target function to its 1-based inclusive line span."""
    found: dict[str, tuple[int, int]] = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name in TARGETS:
            found[node.name] = (node.lineno, node.end_lineno or node.lineno)
    return found


def splice(source: str, found: dict[str, tuple[int, int]]) -> str:
    """Replace the target functions with CANONICAL, keeping one copy in place."""
    lines = source.splitlines()
    anchor = found["pi_native_model_options"]
    # Drop the extra function first so the anchor's indices stay valid, and eat
    # the blank lines that used to separate it from its neighbour.
    for name, (start, end) in sorted(found.items(), key=lambda kv: -kv[1][0]):
        if name == "pi_native_model_options":
            continue
        while start > 1 and not lines[start - 2].strip():
            start -= 1
        del lines[start - 1 : end]
    lines[anchor[0] - 1 : anchor[1]] = CANONICAL.rstrip("\n").splitlines()
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tool-dir", required=True, help="uv tool root for omnigent")
    parser.add_argument(
        "--expected-version",
        required=True,
        help="only patch this omnigent version; anything else is reported and skipped",
    )
    args = parser.parse_args()

    site_packages = find_site_packages(args.tool_dir)
    if site_packages is None:
        log(f"no omnigent install under {args.tool_dir} — nothing to patch")
        return 0

    version = installed_version(site_packages)
    if version != args.expected_version:
        log(
            f"omnigent {version or 'unknown'} is installed but this patch was validated "
            f"against {args.expected_version} — SKIPPING. Re-check whether the Pi model "
            f"picker still needs it, then bump omnigent.modelOptionsPatch.expectedVersion."
        )
        return 0

    target = os.path.join(site_packages, "omnigent", "pi_native_credentials.py")
    try:
        original = open(target, encoding="utf-8").read()
    except OSError as exc:
        log(f"cannot read {target}: {exc}")
        return 0

    try:
        found = spans(original)
    except SyntaxError as exc:
        log(f"{target} does not parse ({exc}) — leaving it alone")
        return 0
    if "pi_native_model_options" not in found:
        log("pi_native_model_options() is gone from this build — leaving it alone")
        return 0

    patched = splice(original, found)
    if patched == original:
        log("already canonical — no change")
        return 0

    backup = target + ".orig"
    if not os.path.exists(backup):
        shutil.copy2(target, backup)
        log(f"kept the pristine file as {os.path.basename(backup)}")

    tmp = target + ".patch-tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(patched)
    try:
        rewritten = spans(open(tmp, encoding="utf-8").read())
        if set(rewritten) != set(TARGETS):
            raise ValueError(f"expected both functions, got {sorted(rewritten)}")
    except (SyntaxError, ValueError) as exc:
        os.unlink(tmp)
        log(f"patched file rejected ({exc}) — original left in place")
        return 0
    os.replace(tmp, target)

    # A stale .pyc would keep serving the old body. mtime invalidation already
    # covers this; dropping the cache makes it certain and costs one import.
    for cached in glob.glob(
        os.path.join(site_packages, "omnigent", "__pycache__", "pi_native_credentials.*.pyc")
    ):
        try:
            os.unlink(cached)
        except OSError:
            pass

    log(f"patched {target} (omnigent {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
