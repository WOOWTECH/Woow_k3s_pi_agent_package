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
SEMVER = re.compile(
    r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)'
    r'(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
    r'(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?'
    r'(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$'
)


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


def is_semver_prerelease(version):
    match = SEMVER.fullmatch(version)
    if match is None:
        raise ValueError(f'not a SemVer 2.0.0 version: {version!r}')
    return match.group(4) is not None


def dockerfile_arg(name):
    values = set(re.findall(rf'^ARG {name}=(\S+)$', DOCKERFILE, re.M))
    assert len(values) == 1, (name, values)
    return values.pop()


class CandidateArchiveTests(unittest.TestCase):
    def test_semver_prerelease_detection_covers_identifiers_and_build_metadata(self):
        for version in ('1.2.3-rc.3', '1.2.3-rc', '1.2.3-beta.1', '1.2.3-alpha.beta', '1.2.3-0'):
            with self.subTest(version=version):
                self.assertTrue(is_semver_prerelease(version))
        for version in ('1.2.3', '1.2.3+build.7'):
            with self.subTest(version=version):
                self.assertFalse(is_semver_prerelease(version))
        for version in ('1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3+'):
            with self.subTest(version=version):
                with self.assertRaises(ValueError):
                    is_semver_prerelease(version)

    def test_every_manifest_archive_is_the_exact_named_package(self):
        for package in MANIFEST['packages']:
            with self.subTest(package=package['name']):
                self.assertEqual(package['file'], package['name'].removeprefix('@').replace('/', '-') + '-' + package['version'] + '.tgz')
                self.assertEqual(sha256((PACKAGES / package['file']).read_bytes()), package['sha256'])
                self.assertRegex(package['sha256'], r'^[0-9a-f]{64}$')
                self.assertRegex(package['sourceCommit'], r'^[0-9a-f]{40}$')
                self.assertIsInstance(package['published'], bool)
                self.assertIs(package['published'], 'releaseURL' in package)
                if package['published']:
                    self.assertTrue(package['releaseURL'].startswith('https://github.com/WOOWTECH/'))
                else:
                    self.assertNotIn('releaseURL', package)
                if is_semver_prerelease(package['version']):
                    self.assertFalse(package['published'], 'prereleases must not claim publication')
                identity = archive_json(package, 'package.json')
                self.assertEqual((identity['name'], identity['version']), (package['name'], package['version']))
                with tarfile.open(PACKAGES / package['file']) as tar:
                    for member in tar:
                        parts = Path(member.name).parts
                        self.assertTrue(parts[0] == 'package' and '..' not in parts and not member.name.startswith('/'), member.name)
                        self.assertTrue(member.isfile() or member.isdir(), member.name)

    def test_archives_beside_the_manifest_are_known_packages(self):
        listed = {package['file'] for package in MANIFEST['packages']}
        self.assertEqual({path.name for path in PACKAGES.glob('*.tgz')}, listed)

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
    def test_image_brand_hashes_match_the_frozen_plugin(self):
        patch = archive_member(AGENT_CONNECT, 'src/brand-identity-patch.mjs').decode()
        server = re.search(r"export const PATCHED_BRAND_SERVER_SHA256 = '([0-9a-f]{64})';", patch).group(1)
        helper = archive_member(AGENT_CONNECT, 'src/brand-identity.mjs')
        image_test = (ROOT / 'tests/image-paseo.mjs').read_text()
        pinned = dict(re.findall(r"(server|helper|patchId): '([0-9a-f]{64})'", image_test))
        self.assertEqual(pinned, {'server': server, 'helper': sha256(helper), 'patchId': sha256(helper + server.encode())})

    def test_image_selects_the_prebuilt_runtime_without_a_second_ownership_layer(self):
        self.assertIn('PI_PASEO_RUNTIME_DIR=/opt/woow/pi-paseo-runtime', DOCKERFILE)
        for name in ('pi-web-start.sh', 'pi-agent-env.sh'):
            self.assertNotRegex((ROOT / 'rootfs/usr/local/bin' / name).read_text(), r'PI_PASEO_RUNTIME_DIR=')
        self.assertIn('COPY --from=piweb-builder --chown=1000:1000 /opt/woow/pi-paseo-runtime /opt/woow/pi-paseo-runtime', DOCKERFILE)
        self.assertNotIn('chown -R 1000:1000 /opt/woow/pi-paseo-runtime', DOCKERFILE)
        self.assertIn('chmod -R a+rX /opt/woow/pi-paseo-runtime', DOCKERFILE.split('# Stage 2')[0])

    def test_combined_adapter_pins_exactly_this_agent_connect_and_this_pi_web(self):
        meta = archive_json(OMNIGENT, 'integrations/pi-web/combined.adapter-meta.json')
        self.assertEqual(OMNIGENT['sourceCommit'], 'f6c20d5150a41d76627f2684e5f338c457f80d09')
        self.assertEqual(AGENT_CONNECT['sourceCommit'], '867d9065f609aa5e32d88f2d55cf07c5d3fadc3e')
        self.assertEqual(OMNIGENT['version'], '0.3.42-rc.5')
        self.assertEqual(AGENT_CONNECT['version'], '0.1.27-rc.5')
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

    def test_product_managed_better_paseo_builtin_matches_the_reviewed_provenance(self):
        expected = AGENT_CONNECT['betterPaseo']
        package = archive_json(AGENT_CONNECT, 'runtime/better-paseo/package.json')
        build = archive_json(AGENT_CONNECT, 'runtime/better-paseo/builtin-build.json')
        provenance = archive_json(AGENT_CONNECT, 'runtime/better-paseo/provenance.json')
        self.assertEqual(AGENT_CONNECT['runtimeRevision'], '0.17.5-r4-8664f2c3f8f5')
        self.assertEqual(package['version'], expected['version'])
        self.assertEqual(build['version'], expected['version'])
        self.assertEqual(provenance['version'], expected['version'])
        self.assertEqual(build['commit'], expected['upstreamCommit'])
        self.assertEqual(provenance['upstreamCommit'], expected['upstreamCommit'])
        self.assertEqual(provenance['smartCommit'], expected['smartCommit'])
        self.assertEqual(expected['smartCommit'], 'a7bfd65a3f39076cf664e28687818c24952e261c')
        self.assertEqual(set(expected['files']), {'index.client.ts', 'index.server.ts', 'server/builtin.js', 'builtin-build.json', 'THIRD_PARTY_NOTICES.txt'})
        for name, digest in expected['files'].items():
            raw = archive_member(AGENT_CONNECT, f'runtime/better-paseo/{name}')
            self.assertEqual(sha256(raw), digest, name)
            self.assertEqual(provenance['files'][name], digest, f'provenance {name}')
        self.assertEqual(expected['builtinSha256'], expected['files']['server/builtin.js'])
        self.assertEqual(build['outputs']['server/builtin.js'], expected['builtinSha256'])
        self.assertEqual(build['outputs']['index.client.ts'], expected['files']['index.client.ts'])
        self.assertEqual(build['outputs']['THIRD_PARTY_NOTICES.txt'], expected['files']['THIRD_PARTY_NOTICES.txt'])
        self.assertEqual(build['tasksChunkId'], expected['tasksChunkId'])
        self.assertEqual(provenance['defaults'], {
            'tasksEnabled': True, 'chatEnabled': False,
            'selfUpdateEnabled': False, 'autoUpdateCheck': False,
        })

    def test_image_startup_reads_the_installed_next_package_version(self):
        smoke = (ROOT / 'tests/image-startup.mjs').read_text()
        self.assertIn('node_modules/next/package.json', smoke)
        self.assertIn("version, '16.3.6'", smoke)

    def test_full_image_acceptance_runs_real_sessions_json_gzip_http_check(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        runner = (ROOT / 'scripts/accept-image.sh').read_text()
        helper = (ROOT / 'tests/sessions-http-json-acceptance.mjs').read_text()
        self.assertIn('COPY tests/image-sessions-json.mjs /opt/woow/tests/image-sessions-json.mjs', dockerfile)
        self.assertIn('COPY tests/sessions-http-json-acceptance.mjs /opt/woow/tests/sessions-http-json-acceptance.mjs', dockerfile)
        self.assertIn('node /opt/woow/tests/image-sessions-json.mjs', runner)
        self.assertIn("'accept-encoding': 'gzip'", helper)
        self.assertIn('gunzipSync(response.body, { maxOutputLength: MAX_JSON_BYTES })', helper)
        self.assertIn("JSON.parse(decoded.toString('utf8'))", helper)
        self.assertIn('await fetchResponse.json()', helper)
        self.assertIn('MAX_WIRE_BYTES = 1024 * 1024', helper)
        self.assertIn("assert.equal(target.hostname, '127.0.0.1'", helper)
        self.assertIn("result.on('aborted'", helper)
        self.assertIn("result.on('error'", helper)
        self.assertIn('minimumSessions = 24', helper)


if __name__ == '__main__':
    unittest.main(verbosity=2)
