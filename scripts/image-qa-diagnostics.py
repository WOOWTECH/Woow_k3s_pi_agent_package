"""Bounded diagnostics for fresh, credential-free task-owned QA containers only."""
import json
from pathlib import Path
import re
import subprocess
import sys


def run(args):
    return subprocess.check_output(['docker', *args], stderr=subprocess.STDOUT, timeout=10).decode(errors='replace')


def snapshot(owner, ids):
    result = []
    for cid in ids:
        try:
            c = json.loads(run(['container', 'inspect', cid]))[0]
            if c['Config'].get('Labels', {}).get('pi.root.qa') != owner:
                result.append({'id': cid, 'diagnostic': 'owner-mismatch'}); continue
            # Never save Config/Env, mounts, process arguments, or user histories.
            state = {k:c['State'].get(k) for k in ('Status','Running','Paused','Restarting','OOMKilled','Dead','ExitCode','StartedAt','FinishedAt')}
            row = {'id':cid, 'state':state, 'ports':c['NetworkSettings'].get('Ports'),
                   'networks':[{k:n.get(k) for k in ('NetworkID','IPAddress')} for n in c['NetworkSettings']['Networks'].values()]}
            try:
                tail = run(['logs','--tail','80',cid])[-16384:]
                tail = re.sub(r'(?im)^.*(?:token|password|authorization|secret|api[_-]?key).*$' , '<redacted sensitive log line>', tail)
                tail = re.sub(r'(https?://[^\s?]+)\?[^\s]+', r'\1?<redacted>', tail)
                row['freshFixtureLogTail'] = tail
            except (subprocess.SubprocessError, OSError):
                row['logUnavailable'] = True
            result.append(row)
        except (subprocess.SubprocessError, OSError, ValueError, KeyError):
            result.append({'id':cid, 'diagnostic':'inspect-unavailable'})
    return result


if __name__ == '__main__':
    owner, status, *ids = sys.argv[1:]
    if not owner.startswith('pi-root-qa-'): raise ValueError('unexpected QA owner')
    Path('image-qa-diagnostics.json').write_text(json.dumps({'acceptanceExitStatusBeforeCleanup':int(status),'containers':snapshot(owner, ids)}, indent=2)+'\n')
