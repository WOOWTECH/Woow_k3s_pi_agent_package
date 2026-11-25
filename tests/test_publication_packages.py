"""Source-only checks of candidate-packages/: manifest, archive digests, Dockerfile pins and the Agent Connect pairing.

No Docker, network or package install. The committed archives are only read; node imports the plugin's own
runtime-layout module so the manifest's runtime revision is the one the archive computes."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
PACKAGES = ROOT / 'candidate-packages'
MANIFEST = json.loads((PACKAGES / 'manifest.json').read_text())
DOCKERFILE = (ROOT / 'Dockerfile').read_text()


def entry(name):
    found = [item for item in MANIFEST['packages'] if item['name'] == name]
    assert len(found) == 1, name
    return found[0]


OMNIGENT = entry('@woowtech/pi-omnigent-plugin')
AGENT_CONNECT = entry('@woowtech/pi-paseo')
SHARED = entry('@woowtech/pi-agent-shared-runtime')


def archive_member(package, name):
    with tarfile.open(PACKAGES / package['file']) as tar:
        return tar.extractfile('package/' + name).read()


def archive_json(package, name):
    return json.loads(archive_member(package, name))


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def dockerfile_arg(name):
    values = set(re.findall(rf'^ARG {name}=(\S+)$', DOCKERFILE, re.M))
    assert len(values) == 1, (name, values)
    return values.pop()


class CandidateArchiveTests(unittest.TestCase):
    def test_every_manifest_archive_is_the_exact_named_package(self):
        for package in MANIFEST['packages']:
            with self.subTest(package=package['name']):
                self.assertEqual(package['file'], package['name'].removeprefix('@').replace('/', '-') + '-' + package['version'] + '.tgz')
                self.assertEqual(sha256((PACKAGES / package['file']).read_bytes()), package['sha256'])
                self.assertRegex(package['sha256'], r'^[0-9a-f]{64}$')
                self.assertRegex(package['sourceCommit'], r'^[0-9a-f]{40}$')
                self.assertIs(package['published'], False)
                identity = archive_json(package, 'package.json')
                self.assertEqual((identity['name'], identity['version']), (package['name'], package['version']))
                with tarfile.open(PACKAGES / package['file']) as tar:
                    for member in tar:
                        parts = Path(member.name).parts
                        self.assertTrue(parts[0] == 'package' and '..' not in parts and not member.name.startswith('/'), member.name)
                        self.assertTrue(member.isfile() or member.isdir(), member.name)

    def test_archives_beside_the_manifest_are_known_packages(self):
        listed = {package['file'] for package in MANIFEST['packages']}
        # woowtech-pi-omnigent-plugin-0.3.34.tgz stays as the previous frozen Omnigent archive; nothing else may linger.
        allowed = listed | {'woowtech-pi-omnigent-plugin-0.3.34.tgz'}
        self.assertEqual({path.name for path in PACKAGES.glob('*.tgz')} - allowed, set())
        self.assertEqual(listed - {path.name for path in PACKAGES.glob('*.tgz')}, set())

    def test_the_dockerfile_installs_exactly_the_manifest_archives(self):
        self.assertEqual((dockerfile_arg('PI_OMNIGENT_VERSION'), dockerfile_arg('PI_OMNIGENT_SHA256')), (OMNIGENT['version'], OMNIGENT['sha256']))
        self.assertEqual((dockerfile_arg('PI_PASEO_VERSION'), dockerfile_arg('PI_PASEO_SHA256')), (AGENT_CONNECT['version'], AGENT_CONNECT['sha256']))
        self.assertEqual((dockerfile_arg('PI_SHARED_RUNTIME_REF'), dockerfile_arg('PI_SHARED_RUNTIME_CANDIDATE_SHA256')),
                         (SHARED['sourceCommit'], SHARED['sha256']))
        # The archive file name follows the ARG, so the digest and version above decide which file is copied.
        for package, arg in ((OMNIGENT, 'PI_OMNIGENT_VERSION'), (AGENT_CONNECT, 'PI_PASEO_VERSION')):
            stem = package['file'].removesuffix(package['version'] + '.tgz')
            self.assertIn(f'COPY candidate-packages/{stem}${{{arg}}}.tgz ', DOCKERFILE)
        self.assertIn('COPY candidate-packages/' + SHARED['file'] + ' ', DOCKERFILE)

    def test_maintenance_gate_pins_track_the_omnigent_manifest_entry(self):
        pins = json.loads((ROOT / 'tests/maintenance-gate-pins.json').read_text())
        self.assertEqual((pins['pluginVersion'], pins['pluginArchiveSha256']), (OMNIGENT['version'], OMNIGENT['sha256']))


class AgentConnectPairingTests(unittest.TestCase):
    def test_combined_adapter_pins_exactly_this_agent_connect_and_this_pi_web(self):
        meta = archive_json(OMNIGENT, 'integrations/pi-web/combined.adapter-meta.json')
        self.assertEqual((meta['paseo']['packageName'], meta['paseo']['packageVersion']), (AGENT_CONNECT['name'], AGENT_CONNECT['version']))
        self.assertEqual(meta['paseo']['adapterPatchSha256'], sha256(archive_member(AGENT_CONNECT, 'host/adapter.patch')))
        self.assertEqual((meta['omnigent']['packageName'], meta['omnigent']['packageVersion']), (OMNIGENT['name'], OMNIGENT['version']))
        self.assertEqual(meta['omnigent']['adapterPatchSha256'], sha256(archive_member(OMNIGENT, 'integrations/pi-web/adapter.patch')))
        combined = sha256(archive_member(OMNIGENT, 'integrations/pi-web/combined.adapter.patch'))
        self.assertEqual(meta['patchSha256'], combined)
        self.assertEqual(dockerfile_arg('PI_OMNIGENT_UI_SHA256'), combined)
        self.assertEqual((meta['baseCommit'], meta['piWebVersion']), (dockerfile_arg('PI_WEB_REF'), dockerfile_arg('PI_WEB_VERSION')))

    def test_the_bundled_paseo_web_client_is_gone_from_both_archives(self):
        with tarfile.open(PACKAGES / AGENT_CONNECT['file']) as tar:
            names = set(tar.getnames())
        self.assertFalse({'package/src/web-client.mjs', 'package/runtime/web-client.json'} & names)
        patch = archive_member(OMNIGENT, 'integrations/pi-web/combined.adapter.patch')
        self.assertIsNone(re.search(rb'^\+\+\+ b/app/paseo-web/', patch, re.M), 'the combined adapter must not add the /paseo-web route')
        self.assertIsNone(re.search(rb'^\+export const config = .*paseo-web', patch, re.M), 'the combined adapter must not match /paseo-web in the Pi Web proxy')

    def test_manifest_runtime_revision_is_the_one_the_archive_computes(self):
        manifest = archive_json(AGENT_CONNECT, 'runtime/package.json')
        with tempfile.TemporaryDirectory(prefix='owned-agent-connect-') as owned:
            root = Path(owned)
            with tarfile.open(PACKAGES / AGENT_CONNECT['file']) as tar:
                for member in tar:
                    relative = member.name.removeprefix('package/')
                    if member.isfile() and relative.split('/')[0] in ('src', 'runtime'):
                        (root / relative).parent.mkdir(parents=True, exist_ok=True)
                        (root / relative).write_bytes(tar.extractfile(member).read())
            script = 'const m = await import(process.argv[1]); console.log(m.RUNTIME_REVISION)'
            result = subprocess.run(['node', '--input-type=module', '-e', script, (root / 'src/runtime-layout.mjs').as_uri()],
                                    capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), AGENT_CONNECT['runtimeRevision'])
        # The Dockerfile and tests/image-paseo.mjs read the Paseo release from the runtime manifest, so it must lead the revision.
        self.assertRegex(AGENT_CONNECT['runtimeRevision'], '^' + re.escape(manifest['dependencies']['@getpaseo/cli']) + r'-r[0-9]+-[0-9a-f]{12}$')


if __name__ == '__main__':
    unittest.main(verbosity=2)
