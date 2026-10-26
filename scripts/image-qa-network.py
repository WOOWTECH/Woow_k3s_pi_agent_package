"""Resolve a running task-owned container on its sole internal bridge."""
import ipaddress
import json
import subprocess
import sys


def endpoint(container, network, owner):
    if not owner.startswith('pi-root-qa-'):
        raise ValueError('unexpected QA owner')
    if any(x.get('Labels', {}).get('pi.root.qa') != owner
           for x in (container['Config'], network)):
        raise ValueError('foreign QA resource')
    state = container['State']
    if not state['Running'] or state.get('Paused') or state.get('Restarting'):
        raise ValueError('QA container is not running; inspect diagnostics')
    if network['Driver'] != 'bridge' or network['Internal'] is not True:
        raise ValueError('QA requires an internal bridge')
    attached = list(container['NetworkSettings']['Networks'].values())
    if len(attached) != 1 or attached[0]['NetworkID'] != network['Id']:
        raise ValueError('QA container must use only its owned internal bridge')
    address = ipaddress.IPv4Address(attached[0]['IPAddress'])
    private = [ipaddress.ip_network(x) for x in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]
    subnets = [ipaddress.ip_network(x['Subnet']) for x in network['IPAM']['Config'] if 'Subnet' in x]
    if not any(address in n for n in private) or not any(address in n for n in subnets):
        raise ValueError('QA address must belong to the owned private bridge subnet')
    return f'http://{address}:30141'


def inspect(kind, resource):
    return json.loads(subprocess.check_output(['docker', kind, 'inspect', resource], timeout=10))[0]


if __name__ == '__main__':
    container_id, network_id, owner = sys.argv[1:]
    print(endpoint(inspect('container', container_id), inspect('network', network_id), owner))
