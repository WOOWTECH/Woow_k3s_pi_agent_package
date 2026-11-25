#!/usr/bin/env python3
"""Additional owned full-image acceptance gate. No deployment/publication API.

Normal CI execution requires an already pulled exact platform manifest image.
Source tests inject a controlled Docker transport and never install an SDK.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
PINS_SHA = 'ed47fa9ff320b796d5b52f91fe998794a5c3f7cdbd2e884f8dd98498bb9ba84e'
PUBLICATION_SHA = '93ac8618fe64329872681f1eb6a94146c249e101458ed8e8af72dc0bca19abd8'
ARCHIVE_SHA = '2ed6aef9d64a3e53166805db76a98437aee44a4401b6cc698bd92c6a79425cde'
NEGATIVES = {'source-drift', 'shared-source-inode', 'console-script-drift', 'unchecked-pyc'}
AFTER = '68f4c2a3c0a3aa75436a15828e325bd279995435d83931d93b12516cca303962'
IMAGE_INFO = '{"Id":{{json .Id}},"Os":{{json .Os}},"Architecture":{{json .Architecture}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}'
CONTAINER_INFO = '{"Image":{{json .Image}},"Owner":{{json (index .Config.Labels "pi.root.qa")}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}}}'
VOLUME_OWNER = '{{json (index .Labels "pi.root.qa")}}'


def require(value, code):
    if not value:
        raise RuntimeError(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_inputs(image, revision, platform, owner):
    require(re.fullmatch(r'ghcr\.io/woowtech/woow-k3s-pi-agent@sha256:[0-9a-f]{64}', image), 'immutable-platform-image-required')
    require(re.fullmatch(r'[0-9a-f]{40}', revision), 'revision-required')
    require(platform in ('linux/amd64', 'linux/arm64'), 'unsupported-platform')
    require(re.fullmatch(r'pi-root-qa-[0-9a-f]{32}', owner), 'owned-qa-identity-required')


def validated_payload(root=ROOT):
    raw = (root / 'tests/maintenance-gate-pins.json').read_bytes()
    require(sha(raw) == PINS_SHA, 'gate-pins-drift')
    pins = json.loads(raw)
    require(pins['pluginArchiveSha256'] == ARCHIVE_SHA and len(pins['pluginFiles']) == 37, 'plugin-pin-scope')
    # The pins file is hash-checked above, so its version names the archive; the archive digest is pinned separately.
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', pins['pluginVersion']), 'plugin-pin-scope')
    archive = root / f"candidate-packages/woowtech-pi-omnigent-plugin-{pins['pluginVersion']}.tgz"
    require(sha(archive.read_bytes()) == ARCHIVE_SHA, 'plugin-archive-drift')
    require(sha((root / 'scripts/image-publication.py').read_bytes()) == PUBLICATION_SHA, 'canonical-publication-drift')
    return pins, (root / 'tests/image-managed-maintenance.mjs').read_text(), (root / 'tests/image-managed-maintenance-check.py').read_text()


def validate_result(value, platform):
    require(value.get('schema') == 'k3s-owned-maintenance-gate/v1' and value.get('passed') is True
            and value.get('platform') == platform and value.get('pluginArchiveSha256') == ARCHIVE_SHA
            and value.get('pluginFilesVerified') == 37, 'offline-proof-identity')
    require(value.get('network') == 'none' and value.get('uid') == 1000
            and value.get('SDKImported') is False and value.get('providerCalls') == 0
            and value.get('tenantData') is False, 'offline-proof-scope')
    installs = value.get('installs', [])
    require([p.get('phase') for p in installs] == ['fresh', 'force'], 'fresh-force-required')
    for item in installs:
        result = item.get('result', {})
        calls = item.get('calls', [])
        require(result.get('ok') is True and result.get('changed') is True
                and result.get('maintenancePreservation', {}).get('state') == 'applied'
                and [c.get('kind') for c in calls] == ['uv', 'guard']
                and calls[0].get('code') == 0 and calls[0].get('copyMode') == 'copy'
                and calls[1].get('code') == 0 and calls[1].get('cacheAndOtherUnchanged') is True,
                'actual-copy-install-and-guard-required')
        guard = calls[1]
        require(guard.get('sourceBefore', {}).get('sha256') == '2a80d492f6f844a8da0e7dbb3e8aaec396a2bbd525f6d042ddc3cf2eed6bccc6'
                and guard['sourceBefore'].get('nlink') == 1
                and guard.get('sourceAfter', {}).get('sha256') == AFTER and guard['sourceAfter'].get('nlink') == 1
                and guard.get('value', {}).get('sdkImported') is False
                and guard['value'].get('consoleScriptValidated') is True, 'real-source-transition-required')
    negatives = value.get('negativeCases', [])
    require(len(negatives) == 4 and {p.get('name') for p in negatives} == NEGATIVES
            and all(p.get('refused') is True and p.get('actualGuard') is True
                    and p.get('inputUnchanged') is True for p in negatives), 'actual-negative-guards-required')
    readback = value.get('finalReadback', {})
    require(readback.get('sourceSha256') == AFTER and readback.get('sourceNlink') == 1
            and readback.get('sourceMode') == '0644' and readback.get('metadataVersion') == '0.16.0'
            and readback.get('sdkImported') is False and readback.get('network') == 'none'
            and readback.get('readOnlyRoot') is True, 'final-installed-source-required')
    require(re.fullmatch(r'3\.12\.[0-9]+', readback.get('python', ''))
            and readback.get('machine') == {'linux/amd64': 'x86_64', 'linux/arm64': 'aarch64'}[platform]
            and readback.get('uid') == readback.get('gid') == 1000, 'final-native-python-required')
    require(len(readback.get('pycs', [])) == 3
            and [p.get('optimization') for p in readback['pycs']] == [0, 1, 2]
            and all(p.get('flags') == 3 and p.get('marshalMatchesSource') is True
                    and p.get('mode') == '0644' and p.get('uid') == p.get('gid') == 1000
                    and re.fullmatch(r'[0-9a-f]{64}', p.get('sha256', ''))
                    for p in readback['pycs']), 'three-checked-hash-caches-required')
    require(value.get('finalGuard', {}).get('ok') is True
            and value['finalGuard'].get('state') == 'verified'
            and value.get('cacheAndOtherAfterNegatives', {}).get('bytesHashed', 0) > 0, 'final-guard-and-cache-required')


def container_args(name, owner, image, platform, volume, phase):
    init = phase == 'init'
    args = ['create', '-i', '--name', name, '--label', 'pi.root.qa=' + owner,
            '--platform', platform, '--network', 'bridge' if phase == 'prefetch' else 'none',
            '--read-only', '--user', '0:0' if init else '1000:1000', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--memory', '256m' if init else '3g',
            '--cpus', '1' if init else '2', '--pids-limit', '32' if init else '128',
            '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,uid=1000,gid=1000,size=134217728',
            '--mount', f'type=volume,source={volume},target=/qa,volume-nocopy']
    if init:
        args += ['--cap-add', 'CHOWN', '--entrypoint', '/usr/bin/python3', image, '-I', '-B', '-']
    else:
        args += ['--entrypoint', 'node', image, '--input-type=module', '-']
    return args


def bounded_process(argv, *, data=None, timeout=40, output_limit=2 * 1024 * 1024):
    """One owned process group, shared output cap and one monotonic deadline.

    Stream stdin too: an attached command may write before it reads the payload.
    No communicate()/capture_output buffering or automatic command replay.
    """
    require(timeout > 0 and output_limit > 0, 'docker-transport-bounds')
    deadline = time.monotonic() + timeout
    process = subprocess.Popen(argv, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    streams = selectors.DefaultSelector()
    output = [bytearray(), bytearray()]
    sent = total = 0
    try:
        for number, pipe in enumerate((process.stdout, process.stderr)):
            os.set_blocking(pipe.fileno(), False)
            streams.register(pipe, selectors.EVENT_READ, number)
        if process.stdin is not None:
            os.set_blocking(process.stdin.fileno(), False)
            if data:
                streams.register(process.stdin, selectors.EVENT_WRITE, None)
            else:
                process.stdin.close()
        while streams.get_map():
            remaining = deadline - time.monotonic()
            require(remaining > 0, 'docker-command-timeout')
            for event, _ in streams.select(remaining):
                require(time.monotonic() < deadline, 'docker-command-timeout')
                pipe = event.fileobj
                if event.data is None:
                    try:
                        sent += os.write(pipe.fileno(), memoryview(data)[sent:sent + 65536])
                    except BrokenPipeError:
                        sent = len(data)
                    except BlockingIOError:
                        continue
                    if sent == len(data):
                        streams.unregister(pipe)
                        pipe.close()
                else:
                    try:
                        chunk = os.read(pipe.fileno(), min(65536, output_limit - total + 1))
                    except BlockingIOError:
                        continue
                    if not chunk:
                        streams.unregister(pipe)
                        pipe.close()
                        continue
                    require(total + len(chunk) <= output_limit, 'docker-output-bound')
                    output[event.data].extend(chunk)
                    total += len(chunk)
        remaining = deadline - time.monotonic()
        require(remaining > 0, 'docker-command-timeout')
        try:
            code = process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise RuntimeError('docker-command-timeout') from None
        return subprocess.CompletedProcess(argv, code, bytes(output[0]), bytes(output[1]))
    except BaseException:
        # This session/group was created by this call. Kill even if the direct
        # child exited but an owned descendant still holds an output pipe open.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        raise
    finally:
        streams.close()
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()


def owned_inspect_absence(args, result):
    """Recognize only the complete single-object Docker28 inspect responses.

    Formatted failed inspect flushes one newline to stdout and exits 1. Bind
    the request's type, format and owned name before comparing all stderr;
    extra diagnostics, other names and unknown response formats stay blocking.
    """
    if result.returncode != 1 or result.stdout != b'\n' or len(args) != 5:
        return False
    if args[1:3] != ['inspect', '--format']:
        return False
    kind, _, _, template, name = args
    volume = r'pi-root-qa-[0-9a-f]{32}-maintenance-(?:amd64|arm64)'
    if kind == 'volume' and template == VOLUME_OWNER and re.fullmatch(volume, name):
        expected = 'Error response from daemon: get ' + name + ': no such volume\n'
    elif kind == 'container' and template == CONTAINER_INFO and re.fullmatch(volume + r'-(?:init|prefetch|offline)', name):
        expected = 'Error response from daemon: No such container: ' + name + '\n'
    else:
        return False
    return result.stderr == expected.encode('ascii')


class Docker:
    def __init__(self, log):
        self.log = log

    def run(self, args, *, data=None, timeout=40, allow_missing=False):
        try:
            result = bounded_process(['docker', *args], data=data, timeout=timeout)
        except Exception as error:
            with self.log.open('a') as stream:
                stream.write(json.dumps({'operation': args[0], 'args': args,
                    'stdinSha256': sha(data) if data is not None else None,
                    'transportError': str(error)[:400], 'commandReplayed': False}) + '\n')
            raise
        entry = {'operation': args[0], 'args': args, 'exit': result.returncode,
                 'stdinSha256': sha(data) if data is not None else None,
                 'stdout': result.stdout.decode(errors='replace'), 'stderr': result.stderr.decode(errors='replace')}
        with self.log.open('a') as stream:
            stream.write(json.dumps(entry) + '\n')
        if allow_missing and result.returncode != 0:
            require(owned_inspect_absence(args, result), 'inspect-failed-not-absence')
            return None
        require(result.returncode == 0, 'docker-operation-failed:' + args[0])
        return result.stdout


def run_gate(image, revision, platform, owner, docker, payload):
    validate_inputs(image, revision, platform, owner)
    pins, program, checker = payload
    info = json.loads(docker.run(['image', 'inspect', '--format', IMAGE_INFO, image]))
    config_id = info['Id']
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', config_id) and info['Os'] == 'linux'
            and info['Architecture'] == platform.split('/')[1]
            and info['revision'] == revision, 'image-config-or-revision')
    suffix = platform.split('/')[1]
    volume = owner + '-maintenance-' + suffix
    containers = []
    volume_attempted = False
    output = None
    try:
        require(docker.run(['volume', 'inspect', '--format', VOLUME_OWNER, volume], allow_missing=True) is None, 'owned-volume-name-already-exists')
        volume_attempted = True
        docker.run(['volume', 'create', '--label', 'pi.root.qa=' + owner, volume])
        for phase in ('init', 'prefetch', 'offline'):
            name = volume + '-' + phase
            require(docker.run(['container', 'inspect', '--format', CONTAINER_INFO, name], allow_missing=True) is None, 'owned-container-name-already-exists')
            containers.append(name)  # Reserve before create: inspect exact name on uncertainty; never replay.
            docker.run(container_args(name, owner, image, platform, volume, phase))
            created = json.loads(docker.run(['container', 'inspect', '--format', CONTAINER_INFO, name]))
            require(created['Image'] == config_id and created['Owner'] == owner,
                    'created-container-config-or-owner-mismatch')
            if phase == 'init':
                data = b'import json,os\nassert os.geteuid()==0 and os.listdir("/qa")==[]\nos.chmod("/qa",0o700)\nos.chown("/qa",1000,1000)\nprint(json.dumps({"initialized":True}))\n'
            else:
                data = ('const INPUT=' + json.dumps({'pins': pins, 'checker': checker, 'phase': phase, 'platform': platform}) + ';\n' + program).encode()
            response = docker.run(['start', '--attach', '--interactive', name], data=data,
                                  timeout={'init': 60, 'prefetch': 240, 'offline': 360}[phase])
            state = json.loads(docker.run(['container', 'inspect', '--format', CONTAINER_INFO, name]))
            require(state['Running'] is False and state['ExitCode'] == 0, 'container-not-successful')
            result = json.loads(response)
            if phase == 'init':
                require(result.get('initialized') is True, 'volume-initialization-failed')
            elif phase == 'prefetch':
                require(result.get('schema') == 'k3s-owned-maintenance-prefetch/v1' and result.get('passed') is True
                        and result.get('maintenanceAcceptance') is False, 'prefetch-not-install-proof')
            else:
                validate_result(result, platform)
                output = result
    finally:
        cleanup_errors = []
        for name in reversed(containers):
            try:
                raw = docker.run(['container', 'inspect', '--format', CONTAINER_INFO, name], allow_missing=True)
                if raw is not None:
                    require(json.loads(raw)['Owner'] == owner, 'cleanup-container-owner')
                    docker.run(['rm', '-f', name])
            except Exception as error:
                cleanup_errors.append(type(error).__name__ + ':container')
        if volume_attempted:
            try:
                raw = docker.run(['volume', 'inspect', '--format', VOLUME_OWNER, volume], allow_missing=True)
                if raw is not None:
                    require(json.loads(raw) == owner, 'cleanup-volume-owner')
                    docker.run(['volume', 'rm', volume])
            except Exception as error:
                cleanup_errors.append(type(error).__name__ + ':volume')
        require(not cleanup_errors, 'owned-cleanup-incomplete:' + ','.join(cleanup_errors))
    require(output is not None, 'offline-proof-missing')
    return {'schema': 'standalone-k3s-maintenance-acceptance/v1', 'passed': True,
            'platformImage': image, 'imageConfigId': config_id, 'revision': revision, 'platform': platform,
            'pluginArchiveSha256': ARCHIVE_SHA, 'ownedCleanupComplete': True, 'proof': output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('image', 'revision', 'platform', 'owner'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    validate_inputs(args.image, args.revision, args.platform, args.owner)
    arch = args.platform.split('/')[1]
    target = Path(f'image-maintenance-{arch}.json')
    require(not target.exists(), 'existing-maintenance-receipt-refused')
    def interrupted(signum, frame):
        raise RuntimeError('owned-gate-interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    result = {'schema': 'standalone-k3s-maintenance-acceptance/v1', 'passed': False,
              'platformImage': args.image, 'revision': args.revision, 'platform': args.platform}
    try:
        result = run_gate(args.image, args.revision, args.platform, args.owner,
                          Docker(Path(f'image-maintenance-{arch}.log')), validated_payload())
    except Exception as error:
        result['error'] = str(error)[:400] if isinstance(error, RuntimeError) else type(error).__name__
    with target.open('x') as stream:
        stream.write(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'passed': result['passed'], 'platform': args.platform, 'receipt': str(target)}))
    return 0 if result['passed'] is True else 1


if __name__ == '__main__':
    raise SystemExit(main())
