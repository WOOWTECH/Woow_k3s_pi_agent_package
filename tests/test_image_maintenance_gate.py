"""Pure owned fixtures; no Docker, SDK install/import, network or live calls."""
import copy
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import marshal
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
# The pins file names the Omnigent archive version; the gate pins that file and the archive digest.
ARCHIVE = 'candidate-packages/woowtech-pi-omnigent-plugin-' + json.loads((ROOT / 'tests/maintenance-gate-pins.json').read_text())['pluginVersion'] + '.tgz'


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


gate = load('owned_maintenance_gate', 'scripts/image-maintenance-gate.py')
checker = load('owned_maintenance_checker', 'tests/image-managed-maintenance-check.py')
OWNER = 'pi-root-qa-' + '1' * 32
REVISION = '2' * 40
IMAGE = 'ghcr.io/woowtech/woow-k3s-pi-agent@sha256:' + '3' * 64
CONFIG = 'sha256:' + '4' * 64


def proof(platform='linux/amd64'):
    """Fabricated protocol fixture, never an actual image acceptance result."""
    guard = {'kind': 'guard', 'code': 0, 'cacheAndOtherUnchanged': True,
             'sourceBefore': {'sha256': checker.BEFORE, 'nlink': 1},
             'sourceAfter': {'sha256': gate.AFTER, 'nlink': 1},
             'value': {'sdkImported': False, 'consoleScriptValidated': True,
                       'pythonExecutable': '/qa/s/uv/tools/omnigent/bin/python', 'sourceSha256': gate.AFTER}}
    result = {'ok': True, 'changed': True, 'maintenancePreservation': {'ok': True, 'state': 'applied', 'sourceSha256': gate.AFTER}}
    return {'schema': 'k3s-owned-maintenance-gate/v1', 'passed': True, 'platform': platform,
            'pluginArchiveSha256': gate.ARCHIVE_SHA, 'pluginFilesVerified': 37,
            'network': 'none', 'uid': 1000, 'SDKImported': False, 'providerCalls': 0, 'tenantData': False,
            'installs': [{'phase': phase, 'result': copy.deepcopy(result), 'calls': [{'kind': 'uv', 'code': 0, 'copyMode': 'copy'}, copy.deepcopy(guard)]}
                         for phase in ['fresh', 'force']],
            'negativeCases': [{'name': name, 'refused': True, 'actualGuard': True, 'inputUnchanged': True} for name in sorted(gate.NEGATIVES)],
            'finalReadback': {'sourceSha256': gate.AFTER, 'sourceNlink': 1, 'sourceMode': '0644', 'metadataVersion': '0.16.0',
                'sdkImported': False, 'network': 'none', 'readOnlyRoot': True, 'python': '3.12.14',
                'machine': 'x86_64' if platform == 'linux/amd64' else 'aarch64', 'uid': 1000, 'gid': 1000,
                'pycs': [{'optimization': n, 'flags': 3, 'marshalMatchesSource': True, 'mode': '0644', 'uid': 1000, 'gid': 1000,
                          'sha256': '5' * 64} for n in range(3)]},
            'finalGuard': {'ok': True, 'state': 'verified'}, 'cacheAndOtherAfterNegatives': {'bytesHashed': 100}}


class ControlledDocker:
    """In-memory Docker protocol only; it cannot execute a container."""
    def __init__(self, platform='linux/amd64', fail_phase=None, config_mismatch=False, foreign_owner=False, result=None):
        self.platform = platform
        self.fail_phase = fail_phase
        self.config_mismatch = config_mismatch
        self.foreign_owner = foreign_owner
        self.result = proof(platform) if result is None else result
        self.calls = []
        self.containers = {}
        self.volumes = {}

    def run(self, args, **options):
        self.calls.append((args, options))
        if args[:2] == ['image', 'inspect']:
            return json.dumps({'Id': CONFIG, 'Os': 'linux', 'Architecture': self.platform.split('/')[1], 'revision': REVISION}).encode()
        if args[:2] == ['volume', 'inspect']:
            return json.dumps(self.volumes[args[-1]]).encode() if args[-1] in self.volumes else None
        if args[:2] == ['volume', 'create']:
            self.volumes[args[-1]] = OWNER
            return args[-1].encode()
        if args[:2] == ['volume', 'rm']:
            del self.volumes[args[-1]]
            return b''
        if args[:2] == ['container', 'inspect']:
            return json.dumps(self.containers[args[-1]]).encode() if args[-1] in self.containers else None
        if args[0] == 'create':
            name = args[args.index('--name') + 1]
            self.containers[name] = {'Image': 'sha256:' + '6' * 64 if self.config_mismatch else CONFIG,
                'Owner': 'foreign' if self.foreign_owner else OWNER, 'Running': False, 'ExitCode': 0}
            return ('7' * 64).encode()
        if args[0] == 'start':
            phase = args[-1].rsplit('-', 1)[-1]
            if phase == self.fail_phase:
                raise RuntimeError('controlled-phase-failure')
            return json.dumps({'initialized': True} if phase == 'init' else
                {'schema': 'k3s-owned-maintenance-prefetch/v1', 'passed': True, 'maintenanceAcceptance': False}
                if phase == 'prefetch' else self.result).encode()
        if args[0] == 'rm':
            del self.containers[args[-1]]
            return b''
        raise AssertionError(args)


class OrchestrationTests(unittest.TestCase):
    def invoke(self, docker):
        return gate.run_gate(IMAGE, REVISION, docker.platform, OWNER, docker, ({}, '// controlled fixture', '# controlled fixture'))

    def test_both_platforms_require_all_phases_and_cleanup_before_pass(self):
        for platform in ['linux/amd64', 'linux/arm64']:
            with self.subTest(platform=platform):
                docker = ControlledDocker(platform)
                result = self.invoke(docker)
                self.assertIs(result['passed'], True)
                self.assertEqual(result['imageConfigId'], CONFIG)
                self.assertEqual([a[-1].rsplit('-', 1)[-1] for a, _ in docker.calls if a[0] == 'start'], ['init', 'prefetch', 'offline'])
                self.assertEqual(docker.containers, {})
                self.assertEqual(docker.volumes, {})

    def test_config_mismatch_refuses_before_start_and_cleans_owned_resource(self):
        docker = ControlledDocker(config_mismatch=True)
        with self.assertRaisesRegex(RuntimeError, 'config-or-owner'):
            self.invoke(docker)
        self.assertFalse(any(a[0] == 'start' for a, _ in docker.calls))
        self.assertEqual(docker.containers, {})

    def test_prefetch_and_offline_failure_never_return_pass_and_cleanup(self):
        for phase in ['prefetch', 'offline']:
            docker = ControlledDocker(fail_phase=phase)
            with self.subTest(phase=phase), self.assertRaises(RuntimeError):
                self.invoke(docker)
            self.assertEqual(docker.containers, {})
            self.assertEqual(docker.volumes, {})

    def test_foreign_owner_is_never_removed(self):
        docker = ControlledDocker(foreign_owner=True)
        with self.assertRaisesRegex(RuntimeError, 'cleanup-incomplete'):
            self.invoke(docker)
        self.assertTrue(docker.containers)
        self.assertFalse(any(a[0] == 'rm' for a, _ in docker.calls))

    def test_existing_owned_volume_name_is_refused_without_reuse_or_deletion(self):
        docker = ControlledDocker()
        docker.volumes[OWNER + '-maintenance-amd64'] = OWNER
        with self.assertRaisesRegex(RuntimeError, 'already-exists'):
            self.invoke(docker)
        self.assertTrue(docker.volumes)
        self.assertFalse(any(a[:2] in [['volume', 'create'], ['volume', 'rm']] for a, _ in docker.calls))

    def test_only_prefetch_gets_network_and_no_host_mounts_or_socket(self):
        for phase in ['init', 'prefetch', 'offline']:
            args = gate.container_args('owned', OWNER, IMAGE, 'linux/amd64', 'owned-volume', phase)
            self.assertEqual(args[args.index('--network') + 1], 'bridge' if phase == 'prefetch' else 'none')
            self.assertIn('--read-only', args)
            self.assertEqual(args[args.index('--cap-drop') + 1], 'ALL')
            self.assertEqual(args[args.index('--user') + 1], '0:0' if phase == 'init' else '1000:1000')
            self.assertNotIn('bind', ' '.join(args))
            self.assertNotIn('docker.sock', ' '.join(args))
            self.assertIn('target=/qa,volume-nocopy', ' '.join(args))

    def test_arbitrary_mutable_or_foreign_identity_refused(self):
        for image, revision, platform, owner in [('owned:latest', REVISION, 'linux/amd64', OWNER),
                (IMAGE, 'short', 'linux/amd64', OWNER), (IMAGE, REVISION, 'linux/riscv64', OWNER),
                (IMAGE, REVISION, 'linux/amd64', 'existing-tenant')]:
            with self.assertRaises(RuntimeError):
                gate.validate_inputs(image, revision, platform, owner)


class ProofTests(unittest.TestCase):
    def test_valid_protocol_fixture(self):
        gate.validate_result(proof(), 'linux/amd64')

    def test_missing_copy_transition_cache_or_negative_cannot_pass(self):
        changes = [lambda p: p['installs'].pop(),
                   lambda p: p['installs'][1]['calls'][0].update(copyMode='hardlink'),
                   lambda p: p['installs'][0]['calls'][1].update(cacheAndOtherUnchanged=False),
                   lambda p: p['installs'][0]['calls'][1]['sourceBefore'].update(nlink=2),
                   lambda p: p['negativeCases'].pop(), lambda p: p['negativeCases'][0].update(refused=False)]
        for change in changes:
            p = proof(); change(p)
            with self.assertRaises(RuntimeError): gate.validate_result(p, 'linux/amd64')

    def test_runtime_source_modes_pycs_and_import_drift_cannot_pass(self):
        changes = [lambda p: p['finalReadback'].update(sourceSha256='0' * 64),
                   lambda p: p['finalReadback'].update(sourceMode='0666'),
                   lambda p: p['finalReadback'].update(machine='aarch64'),
                   lambda p: p['finalReadback']['pycs'].pop(),
                   lambda p: p['finalReadback']['pycs'][0].update(flags=1),
                   lambda p: p.update(SDKImported=True), lambda p: p['finalGuard'].update(ok=False)]
        for change in changes:
            p = proof(); change(p)
            with self.assertRaises(RuntimeError): gate.validate_result(p, 'linux/amd64')

    def test_controlled_transport_negative_failure_prevents_pass(self):
        p = proof(); p['negativeCases'][0]['refused'] = False
        docker = ControlledDocker(result=p)
        with self.assertRaises(RuntimeError): gate.run_gate(IMAGE, REVISION, 'linux/amd64', OWNER, docker, ({}, '', ''))
        self.assertEqual(docker.containers, {})

    def test_pyc_headers_code_filename_and_boundary(self):
        source = b'"owned doc"\nVALUE=1\ndef f():\n assert VALUE\n'
        filename = '/owned/fixture.py'
        for n in range(3):
            raw = importlib.util.MAGIC_NUMBER + (3).to_bytes(4, 'little') + importlib.util.source_hash(source) + marshal.dumps(compile(source, filename, 'exec', dont_inherit=True, optimize=n))
            self.assertTrue(checker.pyc_readback(raw, source, filename, n)['marshalMatchesSource'])
            for bad in [b'xxxx' + raw[4:], raw[:4] + (1).to_bytes(4, 'little') + raw[8:], raw + b'trailing']:
                with self.assertRaises(RuntimeError): checker.pyc_readback(bad, source, filename, n)
            with self.assertRaises(RuntimeError): checker.pyc_readback(raw, source, '/foreign/path.py', n)

    def test_inventory_content_drift_and_symlink_without_target_read(self):
        with tempfile.TemporaryDirectory() as owned:
            root = Path(owned); cache = root / 'cache'; cache.mkdir(); file = cache / 'public-source';file.write_bytes(b'owned1')
            external = root / 'outside'; external.write_bytes(b'owned outside not read'); (cache / 'alias').symlink_to(external)
            before_atime = external.stat().st_atime_ns
            one = checker.snapshot([('cache', cache)])
            self.assertEqual(external.stat().st_atime_ns, before_atime)
            file.write_bytes(b'owned2')
            self.assertNotEqual(one['sha256'], checker.snapshot([('cache', cache)])['sha256'])


class SourceAndReceiptTests(unittest.TestCase):
    def test_narrowed_pins_and_archive_drift_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix='owned-pins-refusal-') as owned:
            root = Path(owned)
            names = ['tests/maintenance-gate-pins.json', 'scripts/image-publication.py', ARCHIVE]
            for name in names:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                (root / name).write_bytes((ROOT / name).read_bytes())
            pins = root / names[0]
            pins.write_text('{"pluginFiles":{}}')
            with self.assertRaisesRegex(RuntimeError, 'pins-drift'): gate.validated_payload(root)
            pins.write_bytes((ROOT / names[0]).read_bytes())
            (root / names[2]).write_bytes(b'owned archive substitution')
            with self.assertRaisesRegex(RuntimeError, 'archive-drift'): gate.validated_payload(root)

    def test_root_plugin_files_and_every_packaged_pin_are_exact(self):
        pins, _, _ = gate.validated_payload()
        expected = {'Dockerfile': '75a0b9404ab314e422cb3ab55dfd0c4ad2979f65b4fbaca5d7e0d21a132746c1',
                    'candidate-packages/manifest.json': 'f1162e0ae66de4fa9adb62e9f51c5d81475333cce984ed6218b74a3f664aa7c1'}
        for name, digest in expected.items(): self.assertEqual(hashlib.sha256((ROOT / name).read_bytes()).hexdigest(), digest)
        with tarfile.open(ROOT / ARCHIVE) as archive:
            files = {m.name.removeprefix('package/'): m for m in archive if m.isfile()}
            self.assertEqual(set(files), set(pins['pluginFiles']))
            for name, item in files.items():
                raw = archive.extractfile(item).read(); pin = pins['pluginFiles'][name]
                self.assertEqual((hashlib.sha256(raw).hexdigest(), len(raw), item.mode & 0o777), (pin['sha256'], pin['bytes'], pin['mode']))

    def test_immutable_publication_and_existing_gates_remain(self):
        self.assertEqual(hashlib.sha256((ROOT / 'scripts/image-publication.py').read_bytes()).hexdigest(), gate.PUBLICATION_SHA)
        script = (ROOT / 'scripts/accept-image.sh').read_text()
        for gate_name in ['image-startup.mjs', 'image-shared-sync-boundary.mjs', 'image-shared-mcp-adapter.mjs', 'image-browser-first.json', 'image-browser-restart.json']:
            self.assertIn(gate_name, script)
        self.assertLess(script.index('python3 scripts/image-maintenance-gate.py'), script.index("Path('image-acceptance.json').write_text"))
        workflow = (ROOT / '.github/workflows/build.yml').read_text()
        self.assertIn('timeout-minutes: 20', workflow)
        self.assertIn('image-maintenance-*.json', workflow)

    def receipt_fixture(self, mutate=None):
        source = (ROOT / 'scripts/accept-image.sh').read_text().split('python3 - "$receipt" "${platform_images[@]}" <<\'PY\'\n', 1)[1].split('\nPY\n', 1)[0]
        with tempfile.TemporaryDirectory(prefix='owned-acceptance-protocol-') as owned:
            root = Path(owned);(root / 'scripts').mkdir()
            (root / 'scripts/image-maintenance-gate.py').write_bytes((ROOT / 'scripts/image-maintenance-gate.py').read_bytes())
            (root / 'candidate.json').write_text(json.dumps({'platforms': ['linux/amd64'], 'revision': REVISION}))
            view = dict(homeUnchanged=True, paseoShortcutAbsent=True, settingsBindingVisible=True, setupConversationCount=0,
                modelRequests=0, firstScreenOmnigentStep=True, paseoStatusWithoutProject=200)
            for phase in ['first', 'restart']:
                (root / ('image-browser-' + phase + '.json')).write_text(json.dumps({'passed': True, 'views': [view, view]}))
            result = {'schema': 'standalone-k3s-maintenance-acceptance/v1', 'passed': True, 'platform': 'linux/amd64',
                'platformImage': IMAGE, 'revision': REVISION, 'ownedCleanupComplete': True, 'proof': proof()}
            if mutate: mutate(result, root)
            (root / 'image-maintenance-amd64.json').write_text(json.dumps(result))
            run = subprocess.run([sys.executable, '-I', '-B', '-', 'candidate.json', IMAGE], input=source,
                cwd=root, text=True, capture_output=True, timeout=10)
            return run.returncode, (root / 'image-acceptance.json').exists()

    def test_final_receipt_protocol_fixture_accepts_only_complete_bound_gate(self):
        self.assertEqual(self.receipt_fixture(), (0, True))
        for change in [lambda r, p: r.update(passed=False), lambda r, p: r.update(revision='8' * 40),
                       lambda r, p: r.update(platformImage='wrong'), lambda r, p: r['proof']['negativeCases'].pop(),
                       lambda r, p: r.update(oversizedFixture='x' * 100000)]:
            code, exists = self.receipt_fixture(change)
            self.assertNotEqual(code, 0)
            self.assertFalse(exists)

    def test_existing_browser_failure_still_blocks_final_receipt(self):
        def change(result, root):
            (root / 'image-browser-first.json').write_text(json.dumps({'passed': False, 'views': []}))
        code, exists = self.receipt_fixture(change)
        self.assertNotEqual(code, 0)
        self.assertFalse(exists)

    def test_node_protocol_validation_is_pure_and_rejects_fake_guard_success(self):
        positive = proof()['installs'][0]
        negative = {'ok': False, 'changed': False, 'maintenancePreservation': {'code': 'MAINTENANCE_PRESERVATION_REQUIRED', 'reason': 'unsafe-source-file'},
                    'steps': [{'dependency': 'omnigent', 'action': 'maintenance-preservation', 'status': 'blocked'}]}
        script = "import assert from 'node:assert/strict';import {validateInstall,validateRefusal} from './tests/image-managed-maintenance.mjs';\n"
        script += 'const positive=' + json.dumps(positive) + ';\n'
        script += "validateInstall(positive.result,positive.calls,'fresh');positive.calls[0].copyMode='hardlink';assert.throws(()=>validateInstall(positive.result,positive.calls,'fresh'));\n"
        script += 'const negative=' + json.dumps(negative) + ';\n'
        script += """
const calls=[{kind:'guard',code:1,value:{ok:false,code:'MAINTENANCE_PRESERVATION_REQUIRED',reason:'unsafe-source-file'},guardInputUnchanged:true}];
const validate=()=>validateRefusal(negative,calls,'unsafe-source-file');
validate();
for (const target of [negative.maintenancePreservation,calls[0].value]) {
  delete target.reason; assert.throws(validate);
  target.reason='unexpected-error'; assert.throws(validate);
  target.reason='unsafe-source-file';
}
calls[0].code=0;assert.throws(validate);console.log('PASS pure protocol fixture');
"""
        r = subprocess.run(['node', '--input-type=module', '-'], input=script, cwd=ROOT, text=True, capture_output=True, timeout=10)
        self.assertEqual(r.returncode, 0, r.stderr)


class BoundedScannerTests(unittest.TestCase):
    def scan(self, root, yielded):
        original = checker.os.scandir
        @contextmanager
        def tracked(fd):
            self.assertIsInstance(fd, int, 'directory scan must use an owned no-follow fd')
            with original(fd) as stream:
                def entries():
                    for entry in stream:
                        yielded.append(entry.name)
                        yield entry
                yield entries()
        return mock.patch.object(checker.os, 'scandir', tracked)

    def test_oversized_directory_stops_during_collection_before_sort(self):
        with tempfile.TemporaryDirectory(prefix='owned-scanner-count-') as owned:
            root = Path(owned)
            for n in range(12): (root / str(n)).write_bytes(b'owned')
            yielded = []
            with self.scan(root, yielded), mock.patch.object(checker, 'SNAPSHOT_MAX_TICKS', 5, create=True), \
                    mock.patch.object(checker.os, 'listdir', side_effect=AssertionError('unbounded listdir forbidden')):
                with self.assertRaisesRegex(RuntimeError, 'inventory-budget'):
                    checker.snapshot([('cache', root)])
            self.assertLessEqual(len(yielded), 5)
            self.assertLess(len(yielded), 12)

    def test_deadline_exhaustion_stops_name_collection(self):
        with tempfile.TemporaryDirectory(prefix='owned-scanner-deadline-') as owned:
            root = Path(owned)
            for n in range(8): (root / str(n)).write_bytes(b'owned')
            yielded = []
            with self.scan(root, yielded), mock.patch.object(checker.time, 'monotonic', side_effect=lambda: 181 if len(yielded) >= 2 else 0), \
                    mock.patch.object(checker.os, 'listdir', side_effect=AssertionError('unbounded listdir forbidden')):
                with self.assertRaisesRegex(RuntimeError, 'inventory-budget'):
                    checker.snapshot([('cache', root)])
            self.assertEqual(len(yielded), 2)


class BoundedTransportTests(unittest.TestCase):
    def child(self, program, *, data=None, timeout=2, output_limit=1024):
        children = []
        original = subprocess.Popen
        def launch(*args, **kwargs):
            child = original(*args, **kwargs); children.append(child); return child
        with mock.patch.object(gate.subprocess, 'Popen', side_effect=launch):
            try:
                return gate.bounded_process([sys.executable, '-I', '-B', '-c', program], data=data,
                    timeout=timeout, output_limit=output_limit)
            finally:
                self.assertEqual(len(children), 1, 'owned command must never be replayed')
                self.assertIsNotNone(children[0].poll(), 'owned child still running')
                self.assertTrue(children[0].stdout.closed and children[0].stderr.closed)

    def test_shared_stdout_stderr_cap_stops_actual_child_in_docker_transport(self):
        children = []; original = subprocess.Popen
        program = 'import os,time;os.write(1,b"o"*(1024*1024+1));os.write(2,b"e"*(1024*1024));time.sleep(2)'
        def launch(argv, **kwargs):
            self.assertEqual(argv[:2], ['docker', 'owned-fixture'])
            child = original([sys.executable, '-I', '-B', '-c', program], **kwargs);children.append(child);return child
        with tempfile.TemporaryDirectory(prefix='owned-output-cap-') as owned, mock.patch.object(gate.subprocess, 'Popen', side_effect=launch):
            start = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, 'docker-output-bound'):
                gate.Docker(Path(owned) / 'bounded.log').run(['owned-fixture'], timeout=5)
            elapsed = time.monotonic() - start
        self.assertEqual(len(children), 1)
        self.assertIsNotNone(children[0].poll())
        self.assertTrue(children[0].stdout.closed and children[0].stderr.closed)
        self.assertLess(elapsed, 1.5, 'overflow was checked after child completion')

    def test_total_deadline_kills_owned_child_even_with_output_or_closed_pipes(self):
        for program in ['import os,time;[(os.write(1,b"x"),time.sleep(.03)) for _ in range(100)]',
                        'import os,time;os.close(1);os.close(2);time.sleep(3)']:
            with self.subTest(program=program):
                start = time.monotonic()
                with self.assertRaisesRegex(RuntimeError, 'docker-command-timeout'):
                    self.child(program, timeout=.15)
                self.assertLess(time.monotonic() - start, 1.5)

    def test_streams_stdin_and_both_outputs_without_deadlock(self):
        result = self.child('import os,sys;os.write(1,b"prefix");os.write(2,b"notice");data=sys.stdin.buffer.read();os.write(1,data)',
            data=b'owned' * 40000, output_limit=256000)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b'prefix' + b'owned' * 40000)
        self.assertEqual(result.stderr, b'notice')

    def test_transport_exception_keeps_existing_owned_cleanup(self):
        docker = ControlledDocker()
        original = docker.run
        def fail(args, **options):
            if args[0] == 'start' and args[-1].endswith('-prefetch'):
                raise RuntimeError('docker-output-bound')
            return original(args, **options)
        docker.run = fail
        with self.assertRaisesRegex(RuntimeError, 'docker-output-bound'):
            gate.run_gate(IMAGE, REVISION, 'linux/amd64', OWNER, docker, ({}, '', ''))
        self.assertEqual(docker.containers, {})
        self.assertEqual(docker.volumes, {})


class PremergeWiringTests(unittest.TestCase):
    def test_gitea_runs_focused_suite_unconditionally_with_all_inputs_and_runtimes(self):
        workflow = (ROOT / '.gitea/workflows/publication-contracts.yml').read_text()
        for block in [workflow.split('  pull_request:\n', 1)[1].split('  push:\n', 1)[0],
                      workflow.split('  push:\n', 1)[1].split('jobs:\n', 1)[0]]:
            for name in ['scripts/image-maintenance-gate.py', 'tests/image-managed-maintenance-check.py',
                         'tests/image-managed-maintenance.mjs', 'tests/maintenance-gate-pins.json',
                         'tests/test_image_maintenance_gate.py', 'Dockerfile', 'candidate-packages/**']:
                self.assertIn("'" + name + "'", block)
        self.assertIn('actions/setup-node@v4', workflow)
        self.assertIn("node-version: '22'", workflow)
        self.assertIn('actions/setup-python@v5', workflow)
        self.assertIn("python-version: '3.12'", workflow)
        job = workflow.split('  publication-contracts:\n', 1)[1]
        self.assertNotIn('if:', job)
        self.assertIn('/tmp/pi-publication-contracts/bin/python -I -B tests/test_image_maintenance_gate.py', job)
        self.assertIn("-m unittest discover -s tests -p 'test_publication_*.py'", job)
        self.assertIn('node --check tests/image-managed-maintenance.mjs', job)


class InspectAbsenceTests(unittest.TestCase):
    # Exact volume response from failed run44993438056/artifact14743700664.
    CI_VOLUME = 'pi-root-qa-2655f8a6a181491fbeed4090242490a1-maintenance-amd64'
    CI_STDERR = b'Error response from daemon: get pi-root-qa-2655f8a6a181491fbeed4090242490a1-maintenance-amd64: no such volume\n'
    # Exact read-only response on the bound Docker28.5.2 daemon; no object created.
    REAL_CONTAINER = 'pi-root-qa-5ae0e47db01b4adfb7fd93f38df64721-maintenance-amd64-init'
    CONTAINER_STDERR = b'Error response from daemon: No such container: pi-root-qa-5ae0e47db01b4adfb7fd93f38df64721-maintenance-amd64-init\n'

    def volume_args(self):
        return ['volume', 'inspect', '--format', gate.VOLUME_OWNER, self.CI_VOLUME]

    def container_args(self):
        return ['container', 'inspect', '--format', gate.CONTAINER_INFO, self.REAL_CONTAINER]

    def replay(self, args, stderr, *, stdout=b'\n', code=1, allow_missing=True):
        with tempfile.TemporaryDirectory(prefix='owned-inspect-replay-') as owned:
            result = subprocess.CompletedProcess(['docker', *args], code, stdout, stderr)
            with mock.patch.object(gate, 'bounded_process', return_value=result) as transport:
                try:
                    return gate.Docker(Path(owned) / 'calls.jsonl').run(args, allow_missing=allow_missing)
                finally:
                    transport.assert_called_once_with(['docker', *args], data=None, timeout=40)
                    entry = json.loads((Path(owned) / 'calls.jsonl').read_text())
                    self.assertEqual((entry['args'], entry['exit'], entry['stdout'], entry['stderr']),
                                     (args, code, stdout.decode(), stderr.decode()))

    def test_captured_ci_volume_response_at_actual_docker_run(self):
        self.assertIsNone(self.replay(self.volume_args(), self.CI_STDERR))

    def test_captured_real_container_and_other_owned_names(self):
        self.assertIsNone(self.replay(self.container_args(), self.CONTAINER_STDERR))
        for arch in ['amd64', 'arm64']:
            volume = OWNER + '-maintenance-' + arch
            args = self.volume_args(); args[-1] = volume
            self.assertIsNone(self.replay(args, ('Error response from daemon: get ' + volume + ': no such volume\n').encode()))
            for phase in ['init', 'prefetch', 'offline']:
                args = self.container_args(); args[-1] = volume + '-' + phase
                self.assertIsNone(self.replay(args, ('Error response from daemon: No such container: ' + args[-1] + '\n').encode()))

    def test_daemon_permission_unknown_foreign_and_mixed_errors_block(self):
        for args, valid in [(self.volume_args(), self.CI_STDERR), (self.container_args(), self.CONTAINER_STDERR)]:
            wrong_name = valid.replace(args[-1].encode(), (args[-1] + '-other').encode())
            errors = [b'', b'Cannot connect to the Docker daemon\n',
                      b'permission denied while trying to connect to the Docker daemon socket\n',
                      b'error during connect: no such file or directory\n',
                      b'No such context: owned\n', b'not found\n', wrong_name,
                      valid.replace(b'volume', b'container') if args[0] == 'volume' else valid.replace(b'container:', b'volume:'),
                      b'permission denied\n' + valid, valid + b'permission denied\n', valid + valid,
                      valid[:-1] + b': permission denied\n', b'prefix ' + valid,
                      valid + b'\n', b'\n' + valid, valid.replace(b'\n', b'\r\n'),
                      valid.replace(b'Error response from daemon:', b'Error:'), valid.lower(), valid.upper()]
            for stderr in errors:
                with self.subTest(kind=args[0], stderr=stderr):
                    with self.assertRaisesRegex(RuntimeError, '^inspect-failed-not-absence$'):
                        self.replay(args, stderr)

    def test_exit_status_and_stdout_must_match_failed_single_inspect(self):
        for args, stderr in [(self.volume_args(), self.CI_STDERR), (self.container_args(), self.CONTAINER_STDERR)]:
            for code in [2, 125, -9]:
                with self.subTest(kind=args[0], code=code), self.assertRaisesRegex(RuntimeError, '^inspect-failed-not-absence$'):
                    self.replay(args, stderr, code=code)
            for stdout in [b'', b'null\n', b'[]\n', b'\n\n', b' \n']:
                with self.subTest(kind=args[0], stdout=stdout), self.assertRaisesRegex(RuntimeError, '^inspect-failed-not-absence$'):
                    self.replay(args, stderr, stdout=stdout)

    def test_only_exact_typed_owned_inspect_request_can_mean_absent(self):
        for args, stderr in [(self.volume_args(), self.CI_STDERR), (self.container_args(), self.CONTAINER_STDERR)]:
            variants = [args + ['another-name'], args[:-1], ['image', *args[1:]],
                        [args[0], 'rm', *args[2:]], [*args[:2], '-f', *args[3:]],
                        [*args[:3], '{{json .}}', args[-1]]]
            for name in ['tenant-name', args[-1] + '-extra', args[-1].replace('amd64', 'riscv64'),
                         args[-1].replace('qa-', 'qa-G'), args[-1].replace('maintenance', 'other')]:
                variants.append([*args[:-1], name])
            for request in variants:
                # Bind the response to the new spelling too: owned scope/type/shape still matters.
                response = stderr.replace(args[-1].encode(), request[-1].encode())
                with self.subTest(request=request), self.assertRaisesRegex(RuntimeError, '^inspect-failed-not-absence$'):
                    self.replay(request, response)

    def test_absence_is_opt_in_and_success_output_stays_available(self):
        with self.assertRaisesRegex(RuntimeError, '^docker-operation-failed:volume$'):
            self.replay(self.volume_args(), self.CI_STDERR, allow_missing=False)
        self.assertEqual(self.replay(self.volume_args(), b'', stdout=b'"existing-owner"\n', code=0), b'"existing-owner"\n')

    def caller(self, stderr):
        calls = []
        image = 'ghcr.io/woowtech/woow-k3s-pi-agent@sha256:a53476f3ede04aab0f3fee1865db2fc330dddedb864bcb1e7f0b1e6ec02ad6fa'
        revision = '36aac417f937692e1cbac4287a908eb71d2cecb3'
        info = {'Id': 'sha256:b9b1da97ead57c755a86c96a7e639e665d307a2337f6f68bddeb54670cfbcee8',
                'Os': 'linux', 'Architecture': 'amd64', 'revision': revision}
        def replay(argv, **options):
            calls.append(argv[1:])
            if argv[1:3] == ['image', 'inspect']:
                return subprocess.CompletedProcess(argv, 0, (json.dumps(info) + '\n').encode(), b'')
            if argv[1:3] == ['volume', 'inspect']:
                self.assertEqual(argv[1:], self.volume_args())
                return subprocess.CompletedProcess(argv, 1, b'\n', stderr)
            self.assertEqual(argv[1:], ['volume', 'create', '--label', 'pi.root.qa=' + self.CI_VOLUME[:43], self.CI_VOLUME])
            raise RuntimeError('fixture-stop-before-volume-create')
        with tempfile.TemporaryDirectory(prefix='owned-caller-replay-') as owned, mock.patch.object(gate, 'bounded_process', side_effect=replay):
            try:
                gate.run_gate(image, revision, 'linux/amd64', self.CI_VOLUME[:43], gate.Docker(Path(owned) / 'calls.jsonl'), ({}, '', ''))
            except RuntimeError as error:
                return str(error), calls
        self.fail('pure replay must stop before volume creation, never emit acceptance')

    def test_capture_reaches_caller_create_boundary_without_executing_it(self):
        error, calls = self.caller(self.CI_STDERR)
        self.assertEqual(error, 'fixture-stop-before-volume-create')
        self.assertEqual([args[:2] for args in calls],
                         [['image', 'inspect'], ['volume', 'inspect'], ['volume', 'create'], ['volume', 'inspect']])

    def test_uncertain_caller_response_never_reaches_create(self):
        for stderr in [b'permission denied\n', b'No such context: owned\n',
                       self.CI_STDERR + b'permission denied\n',
                       self.CI_STDERR.replace(self.CI_VOLUME.encode(), b'foreign-volume')]:
            with self.subTest(stderr=stderr):
                error, calls = self.caller(stderr)
                self.assertEqual(error, 'inspect-failed-not-absence')
                self.assertEqual([args[:2] for args in calls], [['image', 'inspect'], ['volume', 'inspect']])


if __name__ == '__main__':
    unittest.main(verbosity=2)
