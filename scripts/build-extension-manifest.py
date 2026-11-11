"""Bind expected bot commands to the same immutable source used for the service image."""
import json
import re
import sys
from pathlib import Path

revision, source, output = sys.argv[1:]
if not re.fullmatch(r"[0-9a-f]{40}", revision):
    raise SystemExit("A full source revision is required")
actions = sorted(set(re.findall(r"handlers\.set\('([a-z_]+)'", Path(source).read_text())))
if not {"speak_stream", "chat_stream", "meeting_control", "presentation_show", "presentation_stop"} <= set(actions):
    raise SystemExit("Required extension command handlers are absent")
Path(output).write_text(json.dumps({"source_revision": revision, "bot_commands": actions}) + "\n")
