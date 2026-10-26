"""An index digest must resolve to distinct, verified local pull references."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from image_platform_ref import resolve

IMAGE = 'ghcr.io/woowtech/woow-k3s-pi-agent'
INDEX = f'{IMAGE}@sha256:' + 'a' * 64
AMD = f'{IMAGE}@sha256:' + 'b' * 64
ARM = f'{IMAGE}@sha256:' + 'c' * 64


def row(arch, digest):
    return {'platform': {'os': 'linux', 'architecture': arch}, 'digest': digest}


class PlatformManifestRefs(unittest.TestCase):
    def test_two_architectures_use_distinct_child_digests_in_expected_order(self):
        index = {'manifests': [row('arm64', 'sha256:' + 'c' * 64), row('amd64', 'sha256:' + 'b' * 64)]}
        self.assertEqual(resolve(INDEX, index, ['linux/amd64', 'linux/arm64']), [AMD, ARM])

    def test_single_architecture_manifest_keeps_its_immutable_digest(self):
        self.assertEqual(resolve(INDEX, {'schemaVersion': 2}, ['linux/amd64']), [INDEX])
        with self.assertRaises(ValueError):
            resolve(INDEX, {'schemaVersion': 2}, ['linux/amd64', 'linux/arm64'])

    def test_rejects_untrusted_or_ambiguous_index(self):
        good = row('amd64', 'sha256:' + 'b' * 64)
        bad_cases = [
            [good],
            [good, good],
            [good, row('arm64', good['digest'])],
            [good, row('arm64', 'sha256:not-a-digest')],
            [good, row('s390x', 'sha256:' + 'c' * 64)],
        ]
        for rows in bad_cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                resolve(INDEX, {'manifests': rows}, ['linux/amd64', 'linux/arm64'])
        with self.assertRaises(ValueError):
            resolve(f'{IMAGE}:latest', {'manifests': [good]}, ['linux/amd64'])


if __name__ == '__main__':
    unittest.main()
