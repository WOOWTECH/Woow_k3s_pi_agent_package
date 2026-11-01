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
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
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

    def test_missing_install_is_not_an_error(self) -> None:
        result = run(self.tmp / "nothing-here")
        self.assertEqual(result.returncode, 0)
        self.assertIn("nothing to patch", result.stdout)


if __name__ == "__main__":
    unittest.main()
