"""Pathwarden's explicit router registration and build compatibility boundary."""
from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import APIRouter, Header

from .stop_router import _resolve_user_id
from .voice_router import build_voice_router

BUILD = Path(__file__).with_name("_pathwarden_build.json")


def build_extension_router(repo, publisher, *, enabled=True, build_path=BUILD, runtime=None):
    router = APIRouter()
    wired = set()
    if enabled:
        voice = build_voice_router(repo, publisher)
        wired = {(method, route.path) for route in voice.routes for method in route.methods}
        router.include_router(voice)

    @router.get("/bots/capabilities")
    async def capabilities(x_user_id: str | None = Header(default=None)):
        _resolve_user_id(x_user_id)
        try:
            build = json.loads(Path(build_path).read_text())
        except (OSError, ValueError):
            build = {}
        if not isinstance(build, dict):
            build = {}
        source = build.get("source_revision")
        actions = build.get("bot_commands")
        known_build = isinstance(source, str) and re.fullmatch(r"[0-9a-f]{40}", source)
        declared = set(actions) if isinstance(actions, list) and all(isinstance(a, str) for a in actions) else set()
        required = {"speak_stream", "chat_stream", "meeting_control", "presentation_show", "presentation_stop"}
        voice = ("POST", "/bots/{platform}/{native_meeting_id}/speak") in wired
        compatible = bool(voice and known_build and required <= declared)
        from ..bot_spawn.network_session import capability
        return {
            "network_session": await capability(runtime),
            "schema_version": 1,
            "source_revision": source if known_build else None,
            "extension_protocol": "pathwarden-meeting.v1" if compatible else None,
            "contracts": {"commands": "acts.v3", "presence": "room-presence.v1", "invocation": "invocation.v1"} if compatible else {},
            "server_enabled": bool(enabled),
            "expected_bot_commands": sorted(declared) if compatible else [],
            "scope": "build support; per-bot configuration and applied controls require bot observations",
        }

    return router
