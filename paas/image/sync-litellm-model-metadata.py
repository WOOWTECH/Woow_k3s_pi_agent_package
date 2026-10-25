#!/usr/bin/env python3
"""Copy LiteLLM limits into an Omnigent-generated Pi model catalog.

Omnigent creates a provider entry per authenticated gateway identity.  Those
entries use branded model IDs such as ``apporo-elmo/claude-sonnet-5-5``, while
the canonical LiteLLM catalog on the Pi data volume uses
``anthropic/claude-sonnet-5.5``.  Pi otherwise uses its 128K fallback window.
"""

import json
import os
from pathlib import Path
import sys
import tempfile


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} does not contain a JSON object")
    return value


def write_json_atomically(path: Path, value: dict) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def normalized_model_id(model_id: str) -> str:
    """Return the provider-independent spelling used by branded gateway IDs."""
    return model_id.rsplit("/", 1)[-1].replace(".", "-")


def source_metadata(source: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    """Index exact IDs and only unambiguous branded aliases from the catalog."""
    exact: dict[str, dict] = {}
    aliases: dict[str, dict] = {}
    ambiguous: set[str] = set()
    models = source.get("models", [])
    if not isinstance(models, list):
        return exact, aliases
    for model in models:
        if not isinstance(model, dict) or not isinstance(model.get("id"), str):
            continue
        model_id = model["id"]
        exact[model_id] = model
        alias = normalized_model_id(model_id)
        if alias in ambiguous:
            continue
        previous = aliases.get(alias)
        if previous is None or previous.get("id") == model_id:
            aliases[alias] = model
        else:
            aliases.pop(alias, None)
            ambiguous.add(alias)
    return exact, aliases


def synchronize(agent_dir: Path, *, source_path: Path = Path("/data/pi-agent/models.json")) -> None:
    target_path = agent_dir / "models.json"
    if not target_path.is_file() or target_path.resolve() == source_path.resolve():
        return

    source_root = read_json(source_path)
    providers = source_root.get("providers")
    if not isinstance(providers, dict):
        return
    source = providers.get("litellm")
    if not isinstance(source, dict):
        return
    target = read_json(target_path)
    exact, aliases = source_metadata(source)
    if not exact:
        return

    target_providers = target.get("providers")
    if not isinstance(target_providers, dict):
        return
    changed = False
    for provider_name, provider in target_providers.items():
        if not isinstance(provider_name, str) or not isinstance(provider, dict):
            continue
        if not provider_name.startswith("omnigent") or provider.get("baseUrl") != source.get("baseUrl"):
            continue
        models = provider.get("models", [])
        if not isinstance(models, list):
            continue
        for model in models:
            if not isinstance(model, dict) or not isinstance(model.get("id"), str):
                continue
            model_id = model["id"]
            metadata = exact.get(model_id) or aliases.get(normalized_model_id(model_id))
            if metadata is None:
                continue
            # Keep the generated provider's model ID.  Only capabilities and
            # limits come from the canonical LiteLLM catalog.
            updated = dict(model, **{key: value for key, value in metadata.items() if key != "id"})
            if updated != model:
                model.clear()
                model.update(updated)
                changed = True
    if changed:
        write_json_atomically(target_path, target)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: sync-litellm-model-metadata.py <pi-agent-directory>")
    try:
        synchronize(Path(sys.argv[1]))
    except (AttributeError, OSError, ValueError, json.JSONDecodeError) as error:
        # Enrichment must never prevent an agent from opening while a provider
        # temporarily writes incomplete JSON.
        print(f"pi: LiteLLM context metadata sync skipped: {error}", file=sys.stderr)


if __name__ == "__main__":
    main()
