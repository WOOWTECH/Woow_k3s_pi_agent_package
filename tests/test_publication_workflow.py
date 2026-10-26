"""The build boundary must not publish user-facing tags before image acceptance."""
from pathlib import Path
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]


class PublicationWorkflow(unittest.TestCase):
    def test_build_pushes_only_the_unique_candidate(self):
        workflow = yaml.load((ROOT / '.github/workflows/build.yml').read_text(), Loader=yaml.BaseLoader)
        pushes = [step for job in workflow['jobs'].values() for step in job.get('steps', [])
                  if step.get('uses', '').startswith('docker/build-push-action@')]
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0]['with']['tags'], '${{ steps.candidate.outputs.tag }}',
                         'main/latest/semver tags must not be emitted by the pre-QA build step')

    def test_image_acceptance_is_bounded_and_cannot_write_packages(self):
        workflow = yaml.load((ROOT / '.github/workflows/build.yml').read_text(), Loader=yaml.BaseLoader)
        qa = workflow['jobs']['acceptance']
        self.assertEqual(qa['needs'], 'image')
        self.assertEqual(qa['permissions']['packages'], 'read')
        self.assertLessEqual(int(qa['timeout-minutes']), 20)
        self.assertTrue(any(s.get('run') == 'bash scripts/accept-image.sh image-candidate.json' for s in qa['steps']))
        upload = [s for s in qa['steps'] if s.get('uses','').startswith('actions/upload-artifact@')][0]
        self.assertNotIn('if', upload, 'a failed QA must not upload a successful acceptance receipt')

    def test_tag_publication_is_explicit_serialized_and_only_from_main(self):
        workflow = yaml.load((ROOT / '.github/workflows/publish-image.yml').read_text(), Loader=yaml.BaseLoader)
        self.assertEqual(list(workflow['on']), ['workflow_dispatch'])
        self.assertEqual(workflow['concurrency']['cancel-in-progress'], 'false')
        job = workflow['jobs']['publish']
        self.assertEqual(job['if'], "github.ref == 'refs/heads/main'")
        self.assertLessEqual(int(job['timeout-minutes']), 10)
        step = next(s for s in job['steps'] if 'run' in s)
        self.assertEqual(step['run'], 'python3 scripts/image-publication.py --run-id "$CANDIDATE_RUN_ID" --publish')
        self.assertNotIn('${{', step['run'], 'dispatch text must not be interpolated as shell code')


if __name__ == '__main__':
    unittest.main()
