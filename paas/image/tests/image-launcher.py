#!/usr/bin/env python3
"""Probe the final image's unmodified Pi launcher without provider requests.

PATH spies record the actual selected CLI/argv and metadata hook input. The real
metadata hook runs on empty isolated directories; the final model CLI is not run.
No image launcher, environment script or hook is rewritten by this probe.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HOOK = Path('/opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def probe_launcher(launcher, hook=HOOK):
    cases = []
    for explicit in (False, True):
        with tempfile.TemporaryDirectory(prefix='pi-image-launcher-') as temp:
            root = Path(temp)
            canonical = root / 'canonical'
            session = root / 'Omnigent session/agent'
            (canonical / 'home').mkdir(parents=True)
            session.mkdir(parents=True)
            audit = root / 'hook.json'
            spy = root / 'bin'
            spy.mkdir()
            # Absolute interpreter prevents the python3 observer from recursing.
            (spy / 'node').write_text('#!' + sys.executable + '\n' +
                'import json,os,sys\nprint(json.dumps({"agentDir":os.environ["PI_CODING_AGENT_DIR"],"argv":sys.argv[1:]}))\n')
            (spy / 'python3').write_text('#!' + sys.executable + '\n' +
                'import json,os,sys\nfrom pathlib import Path\n' +
                'with open(os.environ["PI_LAUNCHER_TEST_AUDIT"],"a") as out:\n' +
                ' out.write(json.dumps({"agentDir":os.environ["PI_CODING_AGENT_DIR"],"argv":sys.argv[1:]})+"\\n")\n' +
                'os.execv(sys.executable,[sys.executable,*sys.argv[1:]])\n')
            for file in spy.iterdir():
                file.chmod(0o755)
            env = dict(os.environ, HOME=str(canonical / 'home'), PI_AGENT_DATA_DIR=str(canonical),
                       PATH=str(spy) + os.pathsep + os.environ['PATH'], PI_LAUNCHER_TEST_AUDIT=str(audit))
            # Ignore operator shell startup/custom account paths entirely.
            for name in ('PI_CODING_AGENT_DIR', 'BASH_ENV', 'ENV', 'NODE_OPTIONS'):
                env.pop(name, None)
            if explicit:
                env['PI_CODING_AGENT_DIR'] = str(session)
            arguments = ['--offline-contract-probe', 'two words', '', 'literal-$(no-command)']
            run = subprocess.run([str(launcher), *arguments], env=env, cwd=canonical / 'home',
                                 capture_output=True, text=True, timeout=20)
            assert run.returncode == 0, 'image launcher failed in isolated probe'
            output = json.loads(run.stdout)
            expected = str(session if explicit else canonical)
            assert output['agentDir'] == expected, 'launcher replaced the session-selected agent directory'
            assert output['argv'][1:] == arguments, 'launcher changed CLI argument boundaries'
            cli = Path(output['argv'][0])
            assert cli.is_absolute() and cli.is_file(), 'actual image CLI did not resolve'
            hook_calls = [json.loads(line) for line in audit.read_text().splitlines()]
            assert hook_calls == [{'agentDir': expected, 'argv': [str(hook), expected]}], 'metadata hook did not run exactly once with the selected directory'
            cases.append({'mode': 'explicit-session' if explicit else 'default', 'directoryPreserved': True,
                          'argumentsPreserved': True, 'metadataHookCount': 1,
                          'cliPath': str(cli), 'cliSha256': digest(cli)})
    return cases


if __name__ == '__main__':
    assert os.getuid() == 1000, 'final image launcher gate must run as uid 1000'
    resolved = shutil.which('pi')
    assert resolved == '/usr/local/bin/pi', 'unexpected final image command resolution'
    launcher = Path(resolved)
    spec = importlib.util.spec_from_file_location('launcher_patch', Path(__file__).resolve().parents[1] / 'patch-pi-context-window-launcher.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    source = launcher.read_text()
    assert module.patch(source) == source, 'final overlay launcher lacks the exact idempotent guard/hook'
    cases = probe_launcher(launcher)
    print(json.dumps({'passed': True, 'uid': os.getuid(), 'commandResolution': resolved,
                      'launcherSha256': digest(launcher), 'metadataHookSha256': digest(HOOK),
                      'cases': cases, 'modelRequests': 0, 'launcherRewritten': False}))
