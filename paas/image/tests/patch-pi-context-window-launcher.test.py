#!/usr/bin/env python3
"""Execute both image launcher shapes against isolated env/CLI fixtures."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("launcher_patch", ROOT / "patch-pi-context-window-launcher.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
LEGACY = '#!/bin/bash\nset -euo pipefail\nCLI="fixture"\n# shellcheck source=/dev/null\n' + module.ENV_SOURCE + "\n" + module.EXEC
CURRENT = LEGACY.replace("# shellcheck", module.SAVE + "# shellcheck").replace(module.ENV_SOURCE, module.ENV_SOURCE + module.RESTORE)


class LauncherTests(unittest.TestCase):
    def test_preserve_catalog_and_enrich_before_exec_on_both_shapes(self):
        for shape in (LEGACY, CURRENT):
            for override in (None, "/tmp/native session/agent"):
                with self.subTest(override=override, current=shape == CURRENT), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    env_file = root / "env.sh"
                    env_file.write_text('export PI_CODING_AGENT_DIR="/canonical/agent"\n')
                    hook = root / "sync.py"
                    hook.write_text('import os,sys\nassert sys.argv[1] == os.environ["PI_CODING_AGENT_DIR"]\nprint("sync:"+sys.argv[1])\n')
                    node = root / "node"
                    node.write_text('#!/bin/bash\nprintf "exec:%s:%s:%s\\n" "$PI_CODING_AGENT_DIR" "$1" "$2"\n')
                    node.chmod(0o755)
                    patched = module.patch(shape)
                    self.assertEqual(module.patch(patched), patched)
                    self.assertEqual(patched.count(module.SAVE), 1)
                    patched = patched.replace("/usr/local/bin/pi-agent-env.sh", str(env_file)).replace("/opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py", str(hook))
                    env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"])
                    env.pop("PI_CODING_AGENT_DIR", None)
                    if override is not None:
                        env["PI_CODING_AGENT_DIR"] = override
                    result = subprocess.run(["bash", "-c", patched, "pi", "two words"], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    expected = override or "/canonical/agent"
                    self.assertEqual(result.stdout.splitlines(), ["sync:" + expected, "exec:" + expected + ":fixture:two words"])

    def test_unknown_partial_or_duplicated_launcher_fails_without_writes(self):
        for source in ("unknown", CURRENT + module.EXEC, CURRENT.replace(module.RESTORE, ""), module.patch(CURRENT).replace(module.HOOK, "# sync-litellm-model-metadata.py\n")):
            with self.subTest(source=source):
                with self.assertRaises(ValueError):
                    module.patch(source)


if __name__ == "__main__":
    unittest.main()
