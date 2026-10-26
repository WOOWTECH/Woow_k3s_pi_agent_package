#!/usr/bin/env python3
"""Promote one accepted CI digest. Never build, sign approvals, or roll back tags."""
import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request
import zipfile

REPOSITORY = 'WOOWTECH/Woow_k3s_pi_agent_package'
IMAGE = 'ghcr.io/woowtech/woow-k3s-pi-agent'
MEDIA = ('application/vnd.oci.image.index.v1+json',
         'application/vnd.docker.distribution.manifest.list.v2+json',
         'application/vnd.oci.image.manifest.v1+json',
         'application/vnd.docker.distribution.manifest.v2+json')


def require(value, reason):
    if not value:
        raise RuntimeError(reason)


def digest(raw):
    return 'sha256:' + hashlib.sha256(raw).hexdigest()


def promote(run_id, github, registry, expected_revision, now, *, write=False, record=lambda _: None):
    run = github.run(run_id)
    require(run['id'] == run_id and run['path'] == '.github/workflows/build.yml'
            and run['status'] == 'completed' and run['conclusion'] == 'success', 'build run is not successful')
    require(run['repository']['full_name'] == REPOSITORY
            and run['head_repository']['full_name'] == REPOSITORY, 'wrong run repository')
    require(run['event'] in ('push', 'workflow_dispatch'), 'unsupported run event')
    age = now - dt.datetime.fromisoformat(run['updated_at'].replace('Z', '+00:00'))
    require(dt.timedelta() <= age <= dt.timedelta(hours=72), 'acceptance expired or timestamp is in the future')
    jobs = github.jobs(run_id, run['run_attempt'])
    require(all(sum(j['name'] == name and j['status'] == 'completed' and j['conclusion'] == 'success'
                    for j in jobs) == 1 for name in ('image', 'acceptance')), 'required jobs did not pass')
    candidate = github.artifact(run_id, f'image-candidate-{run["run_attempt"]}')
    accepted = github.artifact(run_id, f'image-acceptance-{run["run_attempt"]}')
    require(candidate['schema'] == 1 and candidate['repository'] == REPOSITORY and candidate['image'] == IMAGE,
            'wrong candidate identity')
    revision = candidate['revision']
    require(re.fullmatch(r'[0-9a-f]{40}', revision) and revision == run['head_sha'] == expected_revision,
            'candidate revision is not the publication checkout/main revision')
    require(candidate['run_id'] == run_id and candidate['run_attempt'] == run['run_attempt']
            and candidate['event'] == run['event'], 'candidate run/attempt receipt mismatch')
    require(candidate['tag'] == f'sha-{revision}-{run_id}-{run["run_attempt"]}', 'candidate tag is not unique to this run')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', candidate['digest']), 'invalid candidate digest')
    require(accepted['candidate'] == candidate, 'acceptance receipt differs from candidate')
    require(accepted['passed'] is True, 'acceptance did not pass')
    platforms = candidate['platforms']
    require(platforms in [['linux/amd64'], ['linux/amd64', 'linux/arm64']], 'unsupported platforms')
    checks = {f'startup:{platform}' for platform in platforms} | {
        'first-home-desktop', 'first-home-mobile', 'restart-persistence'}
    require(checks.issubset(set(accepted['checks'])), 'required image checks missing')
    ref = candidate['ref']
    tag = re.fullmatch(r'refs/tags/v(\d+\.\d+\.\d+)', ref)
    require(ref == 'refs/heads/main' or tag, 'unsupported candidate ref')
    require(run['head_branch'] == ref.removeprefix('refs/heads/').removeprefix('refs/tags/'), 'run branch differs from receipt')
    version = candidate['root_version']
    require(re.fullmatch(r'\d+\.\d+\.\d+', version) and github.chart_version(revision) == version,
            'chart version differs from tested source')
    if tag:
        require(platforms == ['linux/amd64', 'linux/arm64'], 'stable tag requires both platforms')
        require(tag.group(1) == version, 'stable tag differs from chart version')

    def current():
        require(github.ref('heads/main') == revision, 'main advanced; do not publish this candidate')
        if tag:
            require(github.ref(ref.removeprefix('refs/')) == revision, 'release tag moved')

    current()
    raw, media_type = registry.manifest(candidate['digest'])
    require(digest(raw) == candidate['digest'] and media_type in MEDIA, 'candidate manifest digest/type mismatch')
    tagged, _ = registry.manifest(candidate['tag'])
    require(digest(tagged) == candidate['digest'], 'candidate tag no longer identifies the tested digest')
    top = json.loads(raw)
    descriptors = top.get('manifests', [{'digest': candidate['digest']}])
    require(1 <= len(descriptors) <= 2, 'unexpected image platform descriptors')
    actual_platforms = []
    for descriptor in descriptors:
        manifest, _ = registry.manifest(descriptor['digest'])
        require(digest(manifest) == descriptor['digest'], 'platform digest mismatch')
        config_digest = json.loads(manifest)['config']['digest']
        config_raw = registry.blob(config_digest)
        require(digest(config_raw) == config_digest, 'config digest mismatch')
        config = json.loads(config_raw)
        require(config['config']['Labels']['org.opencontainers.image.revision'] == revision, 'image revision mismatch')
        actual_platforms.append(config['os'] + '/' + config['architecture'])
    require(sorted(actual_platforms) == platforms, 'image platforms differ from acceptance')
    tags = ([version, '.'.join(version.split('.')[:2]), version.split('.')[0]] if tag else []) + ['main', 'latest']
    if tag:
        existing = registry.manifest(version, missing_ok=True)
        require(existing is None or digest(existing[0]) == candidate['digest'], 'stable version already exists with another digest')
    result = dict(candidate=candidate, digest=candidate['digest'], tags=tags, attempted=[], written=[], published=False)
    record(result)
    for target in tags:
        current()  # Also repeated between individual registry writes; there is no multi-tag transaction.
        if write:
            if target == version:
                existing = registry.manifest(target, missing_ok=True)
                require(existing is None or digest(existing[0]) == candidate['digest'], 'stable version changed during publication')
            result['attempted'].append(target)
            record(result)  # A timeout can occur after the registry accepted a write.
            registry.put(target, raw, media_type)
            result['written'].append(target)
            record(result)
            actual, _ = registry.manifest(target)
            require(digest(actual) == candidate['digest'], 'published tag digest differs from acceptance')
            current()
    result['published'] = write
    record(result)
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, *, headers=None, method='GET', data=None, limit=2_000_000):
    """Bounded I/O; credentials must never follow a signed artifact/blob redirect."""
    req = urllib.request.Request(url, headers=headers or {}, method=method, data=data)
    try:
        response = urllib.request.build_opener(NoRedirect).open(req, timeout=25)
    except urllib.error.HTTPError as error:
        if error.code not in (301, 302, 303, 307, 308) or method != 'GET':
            raise
        location = error.headers['Location']
        require(location.startswith('https://'), 'insecure download redirect')
        response = urllib.request.urlopen(location, timeout=25)
    with response:
        raw = response.read(limit + 1)
        require(len(raw) <= limit, 'response exceeds allowed size')
        return raw, response.headers


class GitHub:
    def __init__(self, token):
        self.headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pi-root-publication'}

    def get(self, endpoint):
        raw, _ = request(f'https://api.github.com/repos/{REPOSITORY}{endpoint}', headers=self.headers)
        return json.loads(raw)

    def run(self, run_id):
        return self.get(f'/actions/runs/{run_id}')

    def jobs(self, run_id, attempt):
        data = self.get(f'/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100')
        require(data['total_count'] <= 100, 'unexpected job count')
        return data['jobs']

    def artifact(self, run_id, name):
        data = self.get(f'/actions/runs/{run_id}/artifacts?per_page=100')
        require(data['total_count'] <= 100, 'unexpected artifact count')
        matches = [a for a in data['artifacts'] if a['name'] == name and not a['expired']]
        require(len(matches) == 1 and matches[0]['size_in_bytes'] < 1_000_000, 'missing/ambiguous acceptance artifact')
        artifact = matches[0]
        raw, _ = request(f'https://api.github.com/repos/{REPOSITORY}/actions/artifacts/{artifact["id"]}/zip',
                         headers=self.headers, limit=1_000_000)
        require(artifact.get('digest') == digest(raw), 'artifact download digest mismatch')
        filename = name.rsplit('-', 1)[0] + '.json'
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            require(archive.namelist() == [filename] and archive.getinfo(filename).file_size < 100_000,
                    'unexpected receipt archive contents')
            return json.loads(archive.read(filename))

    def ref(self, ref):
        obj = self.get('/git/ref/' + ref)['object']
        for _ in range(5):
            if obj['type'] == 'commit':
                return obj['sha']
            require(obj['type'] == 'tag', 'ref does not point to commit/tag')
            obj = self.get('/git/tags/' + obj['sha'])['object']
        raise RuntimeError('tag dereference depth exceeded')

    def chart_version(self, revision):
        content = self.get('/contents/charts/pi-agent/Chart.yaml?ref=' + revision)
        text = base64.b64decode(content['content']).decode()
        return re.search(r'^version: (\d+\.\d+\.\d+)\s*$', text, re.M).group(1)


class Registry:
    def __init__(self, actor, token):
        auth = base64.b64encode((actor + ':' + token).encode()).decode()
        raw, _ = request('https://ghcr.io/token?service=ghcr.io&scope=repository:woowtech/woow-k3s-pi-agent:pull,push',
                         headers={'Authorization': 'Basic ' + auth})
        self.headers = {'Authorization': 'Bearer ' + json.loads(raw)['token'], 'Accept': ', '.join(MEDIA)}

    def manifest(self, ref, missing_ok=False):
        try:
            raw, headers = request(f'https://ghcr.io/v2/woowtech/woow-k3s-pi-agent/manifests/{ref}', headers=self.headers)
            require(headers.get('Docker-Content-Digest') == digest(raw), 'registry manifest digest mismatch')
            return raw, headers['Content-Type'].split(';')[0]
        except urllib.error.HTTPError as error:
            if error.code == 404 and missing_ok:
                return None
            raise

    def blob(self, ref):
        return request(f'https://ghcr.io/v2/woowtech/woow-k3s-pi-agent/blobs/{ref}', headers=self.headers)[0]

    def put(self, tag, raw, media_type):
        _, headers = request(f'https://ghcr.io/v2/woowtech/woow-k3s-pi-agent/manifests/{tag}', method='PUT', data=raw,
                             headers={**self.headers, 'Content-Type': media_type})
        require(headers.get('Docker-Content-Digest') == digest(raw), 'registry did not acknowledge the exact digest')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', type=int, required=True)
    parser.add_argument('--publish', action='store_true', help='write tags after all guards; default is read-only')
    args = parser.parse_args()
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ['GITHUB_REPOSITORY'] == REPOSITORY
            and os.environ['GITHUB_REF'] == 'refs/heads/main', 'publication must run on the official current main workflow')
    token = os.environ['GH_TOKEN']
    def save(value):
        Path('image-publication.json').write_text(json.dumps(value, indent=2) + '\n')
    try:
        result = promote(args.run_id, GitHub(token), Registry(os.environ['GITHUB_ACTOR'], token),
                         os.environ['GITHUB_SHA'], dt.datetime.now(dt.timezone.utc), write=args.publish, record=save)
        print(json.dumps({'digest': result['digest'], 'tags': result['tags'], 'published': result['published']}))
    except Exception as error:
        # HTTP errors can include signed URLs; do not print credentials or response bodies.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        raise SystemExit('publication refused: ' + message) from None
