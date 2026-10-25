#!/usr/bin/env python3
"""Preserve session configuration and enrich its catalog before Pi starts."""

from pathlib import Path
import sys


ENV_SOURCE = "[ -r /usr/local/bin/pi-agent-env.sh ] && source /usr/local/bin/pi-agent-env.sh\n"
EXEC = 'exec node "${CLI}" "$@"\n'
SAVE = 'pi_launcher_agent_dir="${PI_CODING_AGENT_DIR:-}"\n'
RESTORE = '''if [ -n "${pi_launcher_agent_dir}" ]; then
  export PI_CODING_AGENT_DIR="${pi_launcher_agent_dir}"
fi
'''
HOOK = '''# The generated gateway catalog has aliases but no model limits.  Enrich it
# from the canonical LiteLLM catalog before Pi reads the session config.
if ! python3 /opt/woow/pi-agent/context-window/sync-litellm-model-metadata.py "${PI_CODING_AGENT_DIR}"; then
  echo "pi: LiteLLM context metadata sync failed; continuing with the current catalog" >&2
fi

'''


def patch(source: str) -> str:
    """Accept inspected 0.2.x and 0.3.0 launchers; reject unknown/partial shapes."""
    error = "unexpected upstream pi launcher shape; context-window hook was not applied"
    if source.count(ENV_SOURCE) != 1 or source.count(EXEC) != 1:
        raise ValueError(error)
    if "sync-litellm-model-metadata.py" in source:
        if source.count(HOOK) != 1 or not source.endswith(HOOK + EXEC):
            raise ValueError(error)
        if source.count(SAVE) != 1 or source.count(ENV_SOURCE + RESTORE) != 1:
            raise ValueError(error)
        if source.index(SAVE) > source.index(ENV_SOURCE):
            raise ValueError(error)
        return source

    legacy_tail = ENV_SOURCE + "\n" + EXEC
    preserved_tail = ENV_SOURCE + RESTORE + "\n" + EXEC
    if source.endswith(legacy_tail) and SAVE not in source and RESTORE not in source:
        source = source.replace(legacy_tail, SAVE + ENV_SOURCE + RESTORE + "\n" + EXEC)
    elif source.endswith(preserved_tail) and source.count(SAVE) == 1 and source.index(SAVE) < source.index(ENV_SOURCE):
        pass  # Root 0.3.0 already owns preservation; do not add a second wrapper.
    else:
        raise ValueError(error)
    return source.removesuffix(EXEC) + HOOK + EXEC


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: patch-pi-context-window-launcher.py <pi-launcher>")
    path = Path(sys.argv[1])
    try:
        source = path.read_text(encoding="utf-8")
        updated = patch(source)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    if updated != source:
        path.write_text(updated, encoding="utf-8")


if __name__ == "__main__":
    main()
