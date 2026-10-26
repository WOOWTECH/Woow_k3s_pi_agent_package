import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).resolve().parents[1] / 'scripts/image-candidate.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateIdentity(unittest.TestCase):
    def setUp(self):
        self.env = dict(GITHUB_REPOSITORY=candidate.REPOSITORY, GITHUB_SHA='a'*40,
                        GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1', GITHUB_REF='refs/heads/main', GITHUB_EVENT_NAME='push')

    def test_full_revision_and_run_attempt_make_builds_distinct(self):
        first = candidate.candidate(self.env)
        self.assertEqual(first['tag'], 'sha-'+'a'*40+'-123-1')
        second = candidate.candidate({**self.env, 'GITHUB_RUN_ATTEMPT':'2'})
        third = candidate.candidate({**self.env, 'GITHUB_RUN_ID':'124'})
        self.assertEqual(len({first['tag'], second['tag'], third['tag']}), 3)

    def test_tag_build_still_only_names_a_candidate(self):
        result = candidate.candidate({**self.env, 'GITHUB_REF':'refs/tags/v0.3.8'})
        self.assertTrue(result['tag'].startswith('sha-'))
        self.assertNotIn('0.3.8', result['tag'])

    def test_pr_fork_and_non_main_dispatch_cannot_name_publishable_candidates(self):
        for field, value in [('GITHUB_REPOSITORY','someone/fork'), ('GITHUB_EVENT_NAME','pull_request'),
                             ('GITHUB_REF','refs/heads/feature'), ('GITHUB_SHA','abc'), ('GITHUB_RUN_ID','1;echo unsafe')]:
            with self.subTest(field=field), self.assertRaises(AssertionError):
                candidate.candidate({**self.env, field:value})


if __name__ == '__main__':
    unittest.main()
