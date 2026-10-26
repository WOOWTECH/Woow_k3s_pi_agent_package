#!/usr/bin/env python3
"""CI-only candidate identity: a rerun never overwrites the previous build tag."""
import json
import os
from pathlib import Path
import re
import sys

REPOSITORY = 'WOOWTECH/Woow_k3s_pi_agent_package'
IMAGE = 'ghcr.io/woowtech/woow-k3s-pi-agent'


def candidate(env):
    assert env['GITHUB_REPOSITORY'] == REPOSITORY
    revision = env['GITHUB_SHA']
    run, attempt = env['GITHUB_RUN_ID'], env['GITHUB_RUN_ATTEMPT']
    assert re.fullmatch(r'[0-9a-f]{40}', revision)
    assert re.fullmatch(r'[1-9][0-9]*', run) and re.fullmatch(r'[1-9][0-9]*', attempt)
    ref = env['GITHUB_REF']
    assert ref == 'refs/heads/main' or re.fullmatch(r'refs/tags/v\d+\.\d+\.\d+', ref)
    assert env['GITHUB_EVENT_NAME'] in ('push', 'workflow_dispatch')
    return dict(schema=1, repository=REPOSITORY, image=IMAGE, revision=revision,
                run_id=int(run), run_attempt=int(attempt), ref=ref,
                tag=f'sha-{revision}-{run}-{attempt}', event=env['GITHUB_EVENT_NAME'])


if __name__ == '__main__':
    record = candidate(os.environ)
    if sys.argv[1] == 'prepare':
        with open(os.environ['GITHUB_OUTPUT'], 'a') as out:
            out.write(f'tag={IMAGE}:{record["tag"]}\n')
    elif sys.argv[1] == 'record':
        digest = os.environ['CANDIDATE_DIGEST']
        assert re.fullmatch(r'sha256:[0-9a-f]{64}', digest)
        platforms = os.environ['CANDIDATE_PLATFORMS'].split(',')
        assert platforms in [['linux/amd64'], ['linux/amd64', 'linux/arm64']]
        version = re.search(r'^version: (\d+\.\d+\.\d+)\s*$', Path('charts/pi-agent/Chart.yaml').read_text(), re.M).group(1)
        record.update(digest=digest, platforms=platforms, root_version=version)
        Path('image-candidate.json').write_text(json.dumps(record, indent=2) + '\n')
    else:
        raise SystemExit('usage: image-candidate.py prepare|record')
