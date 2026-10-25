#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("sync", Path(__file__).resolve().parents[1] / "sync-litellm-model-metadata.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MetadataTests(unittest.TestCase):
    def test_enrich_matching_gateway_keep_alias_and_credentials_and_ignore_other_gateway(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "canonical.json"
            canonical.write_text(json.dumps({"providers": {"litellm": {"baseUrl": "https://gateway.invalid/v1", "apiKey": "canonical-fixture", "models": [{"id": "anthropic/claude-sonnet-5.5", "contextWindow": 1000000, "maxTokens": 64000, "reasoning": True}]}}}))
            target = root / "models.json"
            target.write_text(json.dumps({"providers": {
                "omnigent-account": {"baseUrl": "https://gateway.invalid/v1", "apiKey": "session-fixture", "models": [{"id": "branded/claude-sonnet-5-5", "contextWindow": 128000}]},
                "omnigent-other": {"baseUrl": "https://other.invalid/v1", "models": [{"id": "branded/claude-sonnet-5-5", "contextWindow": 32000}]},
            }}))
            module.synchronize(root, source_path=canonical)
            data = json.loads(target.read_text())["providers"]
            own = data["omnigent-account"]
            self.assertEqual(own["apiKey"], "session-fixture")
            self.assertEqual(own["models"][0], {"id": "branded/claude-sonnet-5-5", "contextWindow": 1000000, "maxTokens": 64000, "reasoning": True})
            self.assertEqual(data["omnigent-other"]["models"][0]["contextWindow"], 32000)
            before = target.stat().st_mtime_ns
            module.synchronize(root, source_path=canonical)
            self.assertEqual(target.stat().st_mtime_ns, before)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_ambiguous_alias_not_selected_but_exact_ids_still_available(self):
        exact, aliases = module.source_metadata({"models": [{"id": "a/model.v1", "contextWindow": 1000000}, {"id": "b/model-v1", "contextWindow": 32000}]})
        self.assertNotIn("model-v1", aliases)
        self.assertEqual(exact["a/model.v1"]["contextWindow"], 1000000)


if __name__ == "__main__":
    unittest.main()
