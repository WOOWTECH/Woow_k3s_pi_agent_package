"""Safe receipt at the Docker CLI boundary; never export container configuration."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('diagnostics',Path(__file__).resolve().parents[1]/'scripts/image-qa-diagnostics.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Diagnostics(unittest.TestCase):
    def test_state_is_retained_before_cleanup_without_environment_or_credentials(self):
        container={'Config':{'Labels':{'pi.root.qa':'pi-root-qa-test'},'Env':['PASSWORD=env-sensitive']},
                   'State':{'Running':False,'ExitCode':1,'OOMKilled':False,'Error':'secret-error'},
                   'NetworkSettings':{'Ports':{},'Networks':{}}}
        with patch.object(m,'run',side_effect=[json.dumps([container]),'startup failed\nAuthorization: Bearer log-sensitive\npassword=other-sensitive\nhttps://example.test/?token=url-sensitive']):
            receipt=m.snapshot('pi-root-qa-test',['cid'])
        text=json.dumps(receipt)
        self.assertEqual(receipt[0]['state']['ExitCode'],1)
        self.assertIn('startup failed',text)
        for secret in ['env-sensitive','log-sensitive','other-sensitive','url-sensitive','secret-error','Config','Env']:
            self.assertNotIn(secret,text)

    def test_foreign_container_logs_are_never_read(self):
        with patch.object(m,'run',return_value=json.dumps([{'Config':{'Labels':{'pi.root.qa':'foreign'}}}])) as cli:
            self.assertEqual(m.snapshot('pi-root-qa-test',['cid']),[{'id':'cid','diagnostic':'owner-mismatch'}])
            self.assertEqual(cli.call_count,1)
