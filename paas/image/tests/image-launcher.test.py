#!/usr/bin/env python3
"""Negative-capable local tests of the image probe; not image acceptance evidence."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('image_launcher', ROOT / 'image-launcher.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ImageLauncherProbe(unittest.TestCase):
    def test_directory_hook_and_argument_probe_detects_legacy_override(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cli = root / 'cli.js'
            cli.write_text('// Never executed by this probe\n')
            hook = root / 'sync.py'
            hook.write_text('import os,sys\nassert sys.argv[1] == os.environ["PI_CODING_AGENT_DIR"]\n')
            launcher = root / 'pi'
            legacy = f'''#!/bin/bash
set -euo pipefail
export PI_CODING_AGENT_DIR="$PI_AGENT_DATA_DIR"
python3 "{hook}" "$PI_CODING_AGENT_DIR"
exec node "{cli}" "$@"
'''
            launcher.write_text(legacy)
            launcher.chmod(0o755)
            with self.assertRaisesRegex(AssertionError, 'session-selected'):
                probe.probe_launcher(launcher, hook)
            launcher.write_text(legacy.replace('export PI_CODING_AGENT_DIR="$PI_AGENT_DATA_DIR"',
                                              'export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_AGENT_DATA_DIR}"'))
            cases = probe.probe_launcher(launcher, hook)
            self.assertEqual([c['mode'] for c in cases], ['default', 'explicit-session'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
