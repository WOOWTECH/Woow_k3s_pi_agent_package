"""Guards for charts/pi-agent/files/omnigent-model-options-patch.py.

The 0.12.0 edition of that patch silently stopped applying when omnigent moved
on, and each reason was invisible in production: the version gate still named
0.12.0, the module moved from `omnigent/pi_native_credentials.py` into
`omnigent/harnesses/pi_native/credentials.py`, and PaaS started baking the venv
read-only so the write raised instead of logging. These tests pin all three,
plus the contract that the hook never fails the pod.
"""

from __future__ import annotations

import ast
import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPT = REPO / "charts" / "pi-agent" / "files" / "omnigent-model-options-patch.py"

# Shaped like omnigent 0.16.0: the fallback reads the auth.json/models-store
# pair, and the helper the patch adds does not exist yet.
UPSTREAM = textwrap.dedent(
    '''\
    import subprocess
    import logging
    from pathlib import Path

    _LOGGER = logging.getLogger(__name__)


    def _global_pi_agent_dir() -> Path:
        return Path("/data/pi-agent")


    def _read_json_object(path):
        return {}


    def _is_str_object_dict(value):
        return isinstance(value, dict)


    def pi_own_login_model_options(agent_dir=None):
        """Enumerate the models Pi's own login can use."""
        root = agent_dir if agent_dir is not None else _global_pi_agent_dir()
        logged_in = set(_read_json_object(root / "auth.json"))
        if not logged_in:
            return []
        return []


    def untouched_neighbour():
        return "keep me"
    '''
)


# The two functions the PREVIOUS edition of the patcher wrote (timeout 30, reads every two-word line as a model). Venvs that persist across restarts
# (the native installer, the chart on a PVC) already carry this text, and the new patcher must replace it, not stack on it.
PREVIOUS_EDITION = '''\
def pi_own_login_model_options(agent_dir: Path | None = None) -> list[dict[str, object]]:
    """Enumerate the models Pi's own login can use (the unmanaged fallback).

    Upstream reads Pi's ``models-store.json`` filtered to providers with an
    ``auth.json`` entry. Pi only writes that store for providers whose catalog
    it refreshes over the network, so a compatible endpoint declared in
    ``models.json`` -- the documented way to add a gateway -- appears in
    neither file and the picker comes up empty. When the file pair yields
    nothing, ask the installed Pi CLI, which already knows.

    :param agent_dir: Pi agent dir override (tests); defaults to the host's
        own Pi agent dir.
    :returns: Picker options shaped like :func:`pi_native_model_options`,
        qualified as ``provider/model`` -- the reference form Pi's ``--model``
        resolves natively against its own providers.
    """
    root = agent_dir if agent_dir is not None else _global_pi_agent_dir()
    logged_in = set(_read_json_object(root / "auth.json"))
    options: dict[str, dict[str, object]] = {}
    for provider_id, payload in _read_json_object(root / "models-store.json").items():
        if provider_id not in logged_in or not _is_str_object_dict(payload):
            continue
        models = payload.get("models")
        for model in models if isinstance(models, list) else []:
            if not _is_str_object_dict(model):
                continue
            model_id = model.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            qualified = f"{provider_id}/{model_id}"
            name = model.get("name")
            options[qualified] = {
                "id": qualified,
                "model": qualified,
                "displayName": name if isinstance(name, str) and name else model_id,
            }
    if not options:
        return _ambient_pi_model_options()
    return [options[model_id] for model_id in sorted(options)]


def _ambient_pi_model_options() -> list[dict[str, object]]:
    """List models exposed by Pi's own configured providers, without launching one."""
    try:
        result = subprocess.run(
            ["pi", "--list-models"],
            capture_output=True,
            text=True,
            # `pi --list-models` measures ~5s idle on these hosts, and the
            # first minute after a start is not idle -- 15s (upstream's value)
            # expired there and handed the dialog an empty picker, which is the
            # very failure this patch exists to remove.
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

NOTICE = (
    "No models available. Use /login to log into a provider via OAuth or API key. See:\n"
    "  /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/providers.md\n"
    "  /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md\n"
)

TABLE = (
    "provider    model                context  max-out  thinking  images\n"
    "openrouter  vendor/model-a:free  128K     16.4K    no        no\n"
    "anthropic   claude-haiku-4-5     200K     64K      yes       yes\n"
)


def make_install(root: Path, version: str = "0.16.0", legacy: bool = False) -> Path:
    site = root / "lib" / "python3.12" / "site-packages"
    (site / f"omnigent-{version}.dist-info").mkdir(parents=True)
    if legacy:
        module = site / "omnigent" / "pi_native_credentials.py"
    else:
        module = site / "omnigent" / "harnesses" / "pi_native" / "credentials.py"
    module.parent.mkdir(parents=True, exist_ok=True)
    module.write_text(UPSTREAM, encoding="utf-8")
    return module


def run(tool_dir: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--tool-dir", str(tool_dir), *extra],
        capture_output=True,
        text=True,
        # Keep the real host's venvs out of the search: the script falls back to
        # DEFAULT_ROOTS, and a developer machine may actually have one.
        env={**os.environ, "HOME": str(tool_dir.parent)},
    )


def functions(source: str) -> set[str]:
    return {n.name for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)}


class PatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def test_patches_the_0_16_layout(self) -> None:
        module = make_install(self.tmp / "venv")
        result = run(self.tmp / "venv")
        self.assertEqual(result.returncode, 0, result.stderr)
        patched = module.read_text(encoding="utf-8")
        names = functions(patched)
        self.assertIn("pi_own_login_model_options", names)
        self.assertIn("_ambient_pi_model_options", names)
        # Neighbours survive; only the target is spliced.
        self.assertIn("untouched_neighbour", names)
        self.assertIn("pi --list-models", patched)
        self.assertTrue(module.with_suffix(".py.orig").exists())

    def test_is_idempotent(self) -> None:
        module = make_install(self.tmp / "venv")
        run(self.tmp / "venv")
        once = module.read_text(encoding="utf-8")
        second = run(self.tmp / "venv")
        self.assertEqual(second.returncode, 0)
        self.assertIn("already canonical", second.stdout)
        self.assertEqual(once, module.read_text(encoding="utf-8"))

    def test_finds_the_legacy_flat_module(self) -> None:
        module = make_install(self.tmp / "venv", legacy=True)
        result = run(self.tmp / "venv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("_ambient_pi_model_options", functions(module.read_text(encoding="utf-8")))

    def test_skips_an_unvalidated_version(self) -> None:
        module = make_install(self.tmp / "venv", version="0.17.0")
        before = module.read_text(encoding="utf-8")
        result = run(self.tmp / "venv")
        self.assertEqual(result.returncode, 0)
        self.assertIn("SKIPPING", result.stdout)
        self.assertEqual(before, module.read_text(encoding="utf-8"))

    def test_read_only_install_exits_cleanly(self) -> None:
        """PaaS bakes the venv as root and runs as uid 1000; never fail the pod."""
        if os.geteuid() == 0:
            self.skipTest("root ignores the read-only bit")
        module = make_install(self.tmp / "venv")
        before = module.read_text(encoding="utf-8")
        os.chmod(module.parent, 0o555)
        self.addCleanup(os.chmod, module.parent, 0o755)
        result = run(self.tmp / "venv")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("read-only install", result.stdout)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(before, module.read_text(encoding="utf-8"))

    def test_site_packages_is_patched_directly(self) -> None:
        """Build-time entry point: the add-on passes site-packages, not a venv root."""
        module = make_install(self.tmp / "venv")
        site = self.tmp / "venv" / "lib" / "python3.12" / "site-packages"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--site-packages", str(site), "--strict"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("_ambient_pi_model_options", functions(module.read_text(encoding="utf-8")))

    def test_strict_fails_the_build_on_a_version_bump(self) -> None:
        """A silent skip is what let the 0.12.0 edition rot; a build must stop."""
        make_install(self.tmp / "venv", version="0.17.0")
        site = self.tmp / "venv" / "lib" / "python3.12" / "site-packages"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--site-packages", str(site), "--strict"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("SKIPPING", result.stdout)

    def test_missing_install_is_not_an_error(self) -> None:
        result = run(self.tmp / "nothing-here")
        self.assertEqual(result.returncode, 0)
        self.assertIn("nothing to patch", result.stdout)

    def test_converges_from_the_previous_edition(self) -> None:
        """A venv patched by the previous edition ends up byte-identical to a freshly patched one."""
        fresh = make_install(self.tmp / "fresh")
        run(self.tmp / "fresh")
        old = make_install(self.tmp / "old")
        head = UPSTREAM[: UPSTREAM.index("def pi_own_login_model_options")]
        tail = UPSTREAM[UPSTREAM.index("def untouched_neighbour") :]
        old.write_text(head + PREVIOUS_EDITION.rstrip("\n") + "\n\n\n" + tail, encoding="utf-8")
        result = run(self.tmp / "old")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(old.read_text(encoding="utf-8"), fresh.read_text(encoding="utf-8"))
        self.assertNotIn("timeout=30", old.read_text(encoding="utf-8"))


class PatchedPickerTests(unittest.TestCase):
    """Executes the PATCHED stand-in module (no omnigent needed), so the PR gate also covers how the picker reads `pi --list-models`."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        module_path = make_install(self.tmp / "venv")
        result = run(self.tmp / "venv")
        self.assertEqual(result.returncode, 0, result.stderr)
        spec = importlib.util.spec_from_file_location("patched_credentials", module_path)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        # The module gets its own `subprocess`; patching the real one would leak into this file's `run()` helper and into the tests that follow.
        self.fake = types.SimpleNamespace(
            run=None, DEVNULL=subprocess.DEVNULL, SubprocessError=subprocess.SubprocessError, TimeoutExpired=subprocess.TimeoutExpired
        )
        self.module.subprocess = self.fake
        self.agent = self.tmp / "agent"
        self.agent.mkdir()
        self.seen: dict = {}

    def pi_prints(self, stdout: str, returncode: int = 0):
        class Completed:
            pass

        completed = Completed()
        completed.stdout, completed.stderr, completed.returncode = stdout, "", returncode

        def fake(*args, **kwargs):
            self.seen.update(kwargs)
            self.seen["args"] = args
            return completed

        self.fake.run = fake

    def ids(self) -> list[str]:
        return [o["id"] for o in self.module.pi_own_login_model_options(self.agent)]

    def test_the_no_models_notice_is_not_a_model(self) -> None:
        """Pi prints this on STDOUT with exit code 0 when nothing is configured; it used to become a model called `No/models`."""
        self.pi_prints(NOTICE)
        self.assertEqual(self.ids(), [])

    def test_a_table_is_read_and_sorted(self) -> None:
        self.pi_prints(TABLE)
        self.assertEqual(self.ids(), ["anthropic/claude-haiku-4-5", "openrouter/vendor/model-a:free"])

    def test_text_around_the_table_and_separator_rows_are_ignored(self) -> None:
        self.pi_prints("Warning: an update is available\n" + TABLE.splitlines(True)[0] + "-------  -----\n" + "".join(TABLE.splitlines(True)[1:]) + "\n(2 models)\n")
        self.assertEqual(self.ids(), ["anthropic/claude-haiku-4-5", "openrouter/vendor/model-a:free"])

    def test_a_failing_cli_is_an_empty_picker(self) -> None:
        self.pi_prints(TABLE, returncode=1)
        self.assertEqual(self.ids(), [])

    def test_a_missing_or_hung_cli_is_an_empty_picker(self) -> None:
        for error in (OSError("no pi on PATH"), subprocess.TimeoutExpired("pi", 12)):
            def boom(*args, **kwargs):
                raise error

            self.fake.run = boom
            self.assertEqual(self.ids(), [], repr(error))

    def test_the_cli_call_is_bounded_and_aimed_at_the_directory_that_was_read(self) -> None:
        self.pi_prints(TABLE)
        self.ids()
        self.assertEqual(self.seen["args"][0], ["pi", "--list-models"])
        self.assertLess(self.seen["timeout"], 15, "the host RPC is cut off at 15 seconds")
        self.assertEqual(self.seen["env"]["PI_CODING_AGENT_DIR"], str(self.agent))
        self.assertEqual(self.seen["errors"], "replace")
        self.assertEqual(self.seen["stdin"], subprocess.DEVNULL, "Pi must never read the caller's stdin")

    def test_without_a_directory_the_cli_inherits_the_environment(self) -> None:
        self.pi_prints(TABLE)
        self.module.pi_own_login_model_options()
        self.assertIsNone(self.seen["env"])


if __name__ == "__main__":
    unittest.main()
