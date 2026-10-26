"""Docker inspect is the boundary: an internal bridge has no published port."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qa_network', ROOT / 'scripts/image-qa-network.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

OWNER = 'pi-root-qa-fixture'
NETWORK = {'Id':'net-id','Driver':'bridge','Internal':True,'Labels':{'pi.root.qa':OWNER},
           'IPAM':{'Config':[{'Subnet':'172.29.0.0/16'}]}}
CONTAINER = {'Config':{'Labels':{'pi.root.qa':OWNER}},
             'State':{'Running':True,'Paused':False,'Restarting':False,'ExitCode':0,'OOMKilled':False},
             'NetworkSettings':{'Ports':{},'Networks':{'fixture':{'NetworkID':'net-id','IPAddress':'172.29.0.2'}}}}

class InternalBridge(unittest.TestCase):
    def test_running_internal_container_is_reachable_without_public_port(self):
        self.assertEqual(m.endpoint(CONTAINER, NETWORK, OWNER), 'http://172.29.0.2:30141')

    def test_fail_closed_for_exit_foreign_owner_external_network_or_address(self):
        cases = []
        for key, value in [('Running',False), ('Paused',True), ('Restarting',True)]:
            c=copy.deepcopy(CONTAINER); c['State'][key]=value; cases.append((c,NETWORK))
        c=copy.deepcopy(CONTAINER);c['Config']['Labels']['pi.root.qa']='foreign';cases.append((c,NETWORK))
        n=copy.deepcopy(NETWORK);n['Internal']=False;cases.append((CONTAINER,n))
        n=copy.deepcopy(NETWORK);n['Labels']['pi.root.qa']='foreign';cases.append((CONTAINER,n))
        for address in ['8.8.8.8','127.0.0.1','172.30.0.2','']:
            c=copy.deepcopy(CONTAINER);c['NetworkSettings']['Networks']['fixture']['IPAddress']=address;cases.append((c,NETWORK))
        c=copy.deepcopy(CONTAINER);c['NetworkSettings']['Networks']['external']={};cases.append((c,NETWORK))
        c=copy.deepcopy(CONTAINER);c['NetworkSettings']['Networks']['fixture']['NetworkID']='wrong';cases.append((c,NETWORK))
        for c,n in cases:
            with self.subTest(container=c, network=n), self.assertRaises((ValueError,AssertionError)):
                m.endpoint(c,n,OWNER)

if __name__ == '__main__': unittest.main()
