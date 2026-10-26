#!/usr/bin/env python3
"""Select immutable architecture manifests from a candidate image index."""
import json
import re
import subprocess
import sys

IMAGE = 'ghcr.io/woowtech/woow-k3s-pi-agent'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}\Z')
PLATFORMS = ('linux/amd64', 'linux/arm64')


def resolve(image, manifest, expected):
    name, separator, digest = image.partition('@')
    if name != IMAGE or separator != '@' or not DIGEST.fullmatch(digest):
        raise ValueError('candidate must use the expected image and an exact digest')
    if not expected or len(expected) != len(set(expected)) or any(p not in PLATFORMS for p in expected):
        raise ValueError('unsupported or duplicate expected platform')
    entries = manifest.get('manifests')
    if entries is None:
        if expected != ['linux/amd64']:
            raise ValueError('multiarch candidate must have an image index')
        return [image]
    if not isinstance(entries, list):
        raise ValueError('invalid image index')
    found = {}
    for entry in entries:
        platform = entry.get('platform') or {}
        key = f"{platform.get('os')}/{platform.get('architecture')}"
        child = entry.get('digest', '')
        if key not in expected or key in found or child in found.values() or not DIGEST.fullmatch(child):
            raise ValueError('unexpected, duplicate, or invalid child manifest')
        found[key] = child
    if set(found) != set(expected):
        raise ValueError('missing expected child manifest')
    return [f'{name}@{found[p]}' for p in expected]


def main(argv):
    image, *expected = argv
    manifest = json.loads(subprocess.check_output(['docker', 'manifest', 'inspect', image], timeout=45))
    for ref in resolve(image, manifest, expected):
        print(ref)


if __name__ == '__main__':
    main(sys.argv[1:])
