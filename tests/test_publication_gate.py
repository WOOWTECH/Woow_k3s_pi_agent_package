"""Exercise promotion through the GitHub/registry boundary, never live tag writes."""
import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('publication', ROOT / 'scripts/image-publication.py')
publication = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publication)
SHA, NEW_SHA = 'a' * 40, 'b' * 40
NOW = dt.datetime(2026, 10, 26, 13, tzinfo=dt.timezone.utc)


def encoded(value):
    return json.dumps(value, separators=(',', ':')).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


class Registry:
    def __init__(self):
        self.config = encoded({'architecture': 'amd64', 'os': 'linux',
                               'config': {'Labels': {'org.opencontainers.image.revision': SHA}}})
        self.raw = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json',
                            'config': {'digest': digest(self.config)}, 'layers': []})
        self.digest = digest(self.raw)
        self.configs = {digest(self.config): self.config}
        self.manifests = {self.digest: self.raw}
        self.writes = []
        self.after_write = lambda: None

    def manifest(self, ref, missing_ok=False):
        raw = self.manifests.get(ref)
        if raw is None and missing_ok:
            return None
        if raw is None:
            raise RuntimeError('missing manifest')
        return raw, json.loads(raw)['mediaType']

    def blob(self, ref):
        return self.configs[ref]

    def put(self, tag, raw, media_type):
        self.writes.append(tag)
        self.manifests[tag] = raw
        self.after_write()


class GitHub:
    def __init__(self, registry):
        self.head = SHA
        self.tag_head = SHA
        self.run_record = dict(id=123, run_attempt=1, status='completed', conclusion='success',
                               head_sha=SHA, head_branch='main', path='.github/workflows/build.yml',
                               event='push', updated_at='2026-10-26T12:00:00Z',
                               repository={'full_name': publication.REPOSITORY},
                               head_repository={'full_name': publication.REPOSITORY})
        self.job_records = [dict(name=n, conclusion='success', status='completed') for n in ('image', 'acceptance')]
        self.candidate = dict(schema=1, repository=publication.REPOSITORY, image=publication.IMAGE,
                              revision=SHA, run_id=123, run_attempt=1, ref='refs/heads/main',
                              tag=f'sha-{SHA}-123-1', event='push', digest=registry.digest,
                              platforms=['linux/amd64'], root_version='0.3.8')
        registry.manifests[self.candidate['tag']] = registry.raw
        self.acceptance = dict(candidate=copy.deepcopy(self.candidate), passed=True,
                               checks=['startup:linux/amd64', 'first-home-desktop', 'first-home-mobile', 'restart-persistence'])

    def run(self, run_id):
        assert run_id == 123
        return self.run_record

    def jobs(self, run_id, attempt):
        assert (run_id, attempt) == (123, self.run_record['run_attempt'])
        return self.job_records

    def artifact(self, run_id, name):
        assert run_id == 123
        return self.candidate if name.startswith('image-candidate-') else self.acceptance

    def ref(self, ref):
        return self.head if ref == 'heads/main' else self.tag_head

    def chart_version(self, revision):
        assert revision == SHA
        return '0.3.8'


def stable_fixture(github, registry):
    arm = encoded({'architecture':'arm64', 'os':'linux',
                   'config':{'Labels':{'org.opencontainers.image.revision':SHA}}})
    registry.configs[digest(arm)] = arm
    manifest = encoded({'schemaVersion':2, 'mediaType':'application/vnd.oci.image.manifest.v1+json',
                        'config':{'digest':digest(arm)}, 'layers':[]})
    registry.manifests[digest(manifest)] = manifest
    index = encoded({'schemaVersion':2, 'mediaType':'application/vnd.oci.image.index.v1+json',
                     'manifests':[{'digest':registry.digest}, {'digest':digest(manifest)}]})
    registry.digest = digest(index)
    registry.manifests[registry.digest] = index
    registry.manifests[github.candidate['tag']] = index
    github.candidate.update(digest=registry.digest, ref='refs/tags/v0.3.8', platforms=['linux/amd64','linux/arm64'])
    github.run_record['head_branch'] = 'v0.3.8'
    github.acceptance['candidate'] = copy.deepcopy(github.candidate)
    github.acceptance['checks'].append('startup:linux/arm64')


class PublicationGate(unittest.TestCase):
    def setUp(self):
        self.registry = Registry()
        self.github = GitHub(self.registry)

    def promote(self, write=True):
        return publication.promote(123, self.github, self.registry, SHA, NOW, write=write)

    def rejected(self, message):
        with self.assertRaisesRegex(RuntimeError, message):
            self.promote()
        self.assertEqual(self.registry.writes, [], 'rejected inputs must not change any registry tag')

    def test_success_copies_the_tested_manifest_without_rebuild(self):
        result = self.promote()
        self.assertEqual(self.registry.writes, ['main', 'latest'])
        self.assertEqual(result['digest'], self.registry.digest)
        self.assertEqual(self.registry.manifests['latest'], self.registry.raw)

    def test_dry_run_has_no_registry_writes(self):
        self.assertFalse(self.promote(write=False)['published'])
        self.assertEqual(self.registry.writes, [])

    def test_failed_cancelled_pending_or_wrong_workflow_cannot_publish(self):
        for field, value in [('conclusion', 'failure'), ('conclusion', 'cancelled'),
                             ('status', 'in_progress'), ('path', '.github/workflows/other.yml')]:
            with self.subTest(field=field, value=value):
                self.setUp(); self.github.run_record[field] = value; self.rejected('run')

    def test_each_required_job_must_succeed_in_the_same_attempt(self):
        for jobs in [self.github.job_records[:1], [dict(name='image', status='completed', conclusion='success'),
                                                  dict(name='acceptance', status='completed', conclusion='skipped')]]:
            self.github.job_records = jobs; self.rejected('jobs')

    def test_other_repository_or_pull_request_run_rejected(self):
        self.github.run_record['head_repository'] = {'full_name': 'someone/fork'}
        self.rejected('repository')
        self.setUp(); self.github.run_record['event'] = 'pull_request'; self.rejected('event')

    def test_stale_branch_or_old_acceptance_rejected(self):
        self.github.head = NEW_SHA; self.rejected('main')
        self.setUp(); self.github.run_record['updated_at'] = '2026-10-20T12:00:00Z'; self.rejected('expired')

    def test_receipts_cannot_mix_digest_revision_or_attempt(self):
        for field, value in [('digest', 'sha256:'+'e'*64), ('revision', NEW_SHA), ('run_attempt', 2)]:
            with self.subTest(field=field):
                self.setUp(); self.github.acceptance['candidate'][field] = value; self.rejected('receipt')

    def test_missing_browser_or_startup_check_rejected(self):
        self.github.acceptance['checks'].remove('first-home-mobile'); self.rejected('checks')
        self.setUp(); self.github.acceptance['passed'] = False; self.rejected('acceptance')

    def test_candidate_tag_overwrite_or_revision_mismatch_rejected(self):
        self.registry.manifests[self.github.candidate['tag']] = encoded({'mediaType': 'invalid'})
        self.rejected('candidate tag')
        self.setUp()
        self.registry.configs[digest(self.registry.config)] = encoded({'architecture':'amd64', 'os':'linux', 'config':{'Labels':{'org.opencontainers.image.revision':NEW_SHA}}})
        # Preserve manifest bytes so a changed config cannot be hidden by its old digest.
        self.rejected('config digest')

    def test_main_change_after_first_write_stops_remaining_aliases(self):
        self.registry.after_write = lambda: setattr(self.github, 'head', NEW_SHA)
        with self.assertRaisesRegex(RuntimeError, 'main'):
            self.promote()
        self.assertEqual(self.registry.writes, ['main'])
        self.assertNotIn('latest', self.registry.manifests)

    def test_write_timeout_records_possible_partial_publication_without_rollback(self):
        receipts = []
        def timeout_after_write(tag, raw, media):
            self.registry.manifests[tag] = raw
            raise TimeoutError('response lost after the registry accepted it')
        self.registry.put = timeout_after_write
        with self.assertRaises(TimeoutError):
            publication.promote(123, self.github, self.registry, SHA, NOW, write=True,
                                record=lambda value: receipts.append(copy.deepcopy(value)))
        self.assertEqual(receipts[-1]['attempted'], ['main'])
        self.assertEqual(receipts[-1]['written'], [])
        self.assertFalse(receipts[-1]['published'])
        self.assertNotIn('latest', self.registry.manifests)

    def test_stable_tag_requires_both_platforms_and_exact_current_tag(self):
        self.github.candidate['ref'] = 'refs/tags/v0.3.8'
        self.github.run_record['head_branch'] = 'v0.3.8'
        self.github.acceptance['candidate'] = copy.deepcopy(self.github.candidate)
        self.rejected('platforms')

    def test_stable_promotion_preserves_the_accepted_multiarch_index(self):
        stable_fixture(self.github, self.registry)
        result = self.promote()
        self.assertEqual(result['tags'], ['0.3.8', '0.3', '0', 'main', 'latest'])
        for tag in result['tags']:
            self.assertEqual(digest(self.registry.manifests[tag]), self.registry.digest)

    def test_existing_stable_version_is_never_replaced(self):
        stable_fixture(self.github, self.registry)
        self.registry.manifests['0.3.8'] = self.registry.raw
        self.rejected('stable version already exists')

    def test_stable_tag_movement_and_chart_version_mismatch_rejected(self):
        stable_fixture(self.github, self.registry)
        self.github.tag_head = NEW_SHA; self.rejected('tag moved')
        self.github.tag_head = SHA
        self.github.candidate['root_version'] = '0.3.7'
        self.github.acceptance['candidate'] = copy.deepcopy(self.github.candidate)
        self.rejected('chart version')

    def test_rerun_cannot_reuse_previous_attempt_receipt(self):
        self.github.run_record['run_attempt'] = 2
        self.rejected('attempt receipt')


if __name__ == '__main__':
    unittest.main()
