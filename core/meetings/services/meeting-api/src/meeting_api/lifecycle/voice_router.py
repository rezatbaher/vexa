"""Voice-agent HTTP routes — push commands INTO a live meeting (speak / chat / screen).

The gateway (api.v1) already forwards ``POST /bots/{platform}/{native}/speak`` (+ its DELETE),
``POST .../chat`` and ``POST/DELETE .../screen`` to meeting-api — but the open-core build never
mounted the handlers, so they 404'd (the "Mid-call bot config / speak returns 404 in open-core"
status). This mounts them, mirroring ``stop_router`` exactly: resolve the caller's ACTIVE meeting
(``repo.find_active``) and PUBLISH the corresponding ``acts.v1`` command to
``bot_commands:meeting:{id}`` — the same channel + injected ``CommandPublisher`` the ``leave``
command uses.

The bot (spawned with ``voice_agent_enabled=true``) executes the act:

  * ``speak`` / ``speak_stop`` — IMPLEMENTED in the bot today. Speech is synthesized by the bot via
    ``TTS_SERVICE_URL`` (OpenAI-compatible ``POST /v1/audio/speech``, PCM) — point that env at a
    Kokoro-FastAPI instance and the agent speaks in the meeting with your own TTS voice.
  * ``chat_send`` / ``screen_show`` / ``screen_stop`` — the command is published; the bot's DOM
    handler for these is a follow-up (the act is currently ignored by the bot's voice handler).

This route only TRIGGERS the act (fire-and-forget over redis); it never mutates the FSM. A meeting
that isn't active (or wasn't spawned voice-enabled) → 404.
"""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Header, HTTPException, Request

from ..bot_spawn.ports import MeetingRepo
from .stop import leave_command_channel  # the shared bot-command channel: bot_commands:meeting:{id}
from .stop_router import CommandPublisher, _resolve_user_id

_SUPPORTED_PLATFORMS = frozenset({"google_meet", "zoom", "teams", "jitsi", "browser_session"})


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return {}
    return body if isinstance(body, dict) else {}


def build_voice_router(repo: MeetingRepo, publisher: CommandPublisher) -> APIRouter:
    """Voice-agent routes over the injected ``MeetingRepo`` + ``CommandPublisher`` ports."""
    router = APIRouter()

    async def _resolve_meeting_id(platform: str, native: str, x_user_id: Optional[str]) -> int:
        user_id = _resolve_user_id(x_user_id)
        if platform not in _SUPPORTED_PLATFORMS:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported platform '{platform}' — must be one of: "
                f"{', '.join(sorted(_SUPPORTED_PLATFORMS))}",
            )
        meeting = await repo.find_active(user_id, platform, native)
        if not meeting:
            raise HTTPException(status_code=404, detail="No active meeting for this bot")
        return meeting["id"]

    async def _publish(meeting_id: int, act: dict) -> None:
        await publisher.publish(leave_command_channel(meeting_id), json.dumps(act))

    @router.post("/bots/{platform}/{native_meeting_id}/speak", status_code=202)
    async def speak(
        platform: str,
        native_meeting_id: str,
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        mid = await _resolve_meeting_id(platform, native_meeting_id, x_user_id)
        body = await _json_body(request)
        text = body.get("text")
        audio_b64 = body.get("audio_base64")
        audio_url = body.get("audio_url")
        if audio_b64 or audio_url:
            act: dict = {"action": "speak_audio"}
            if audio_url:
                act["url"] = audio_url
            if audio_b64:
                act["audioBase64"] = audio_b64
        elif text:
            act = {"action": "speak", "text": str(text)}
            if body.get("voice"):
                act["voice"] = str(body["voice"])
        else:
            raise HTTPException(status_code=422, detail="speak requires text, audio_base64, or audio_url")
        await _publish(mid, act)
        return {"status": "speaking", "meeting_id": mid}

    @router.delete("/bots/{platform}/{native_meeting_id}/speak")
    async def speak_stop(
        platform: str,
        native_meeting_id: str,
        x_user_id: Optional[str] = Header(default=None),
    ):
        mid = await _resolve_meeting_id(platform, native_meeting_id, x_user_id)
        await _publish(mid, {"action": "speak_stop"})
        return {"status": "speak_stopped", "meeting_id": mid}

    @router.post("/bots/{platform}/{native_meeting_id}/chat", status_code=202)
    async def chat_send(
        platform: str,
        native_meeting_id: str,
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        mid = await _resolve_meeting_id(platform, native_meeting_id, x_user_id)
        body = await _json_body(request)
        text = (body.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=422, detail="chat requires 'text'")
        await _publish(mid, {"action": "chat_send", "text": text})
        return {"status": "chat_sent", "meeting_id": mid}

    @router.post("/bots/{platform}/{native_meeting_id}/screen", status_code=202)
    async def screen_show(
        platform: str,
        native_meeting_id: str,
        request: Request,
        x_user_id: Optional[str] = Header(default=None),
    ):
        mid = await _resolve_meeting_id(platform, native_meeting_id, x_user_id)
        body = await _json_body(request)
        if not body.get("type"):
            raise HTTPException(status_code=422, detail="screen requires 'type'")
        act = {"action": "screen_show"}
        if body.get("url"):
            act["imageUrl"] = body["url"]
        if body.get("html"):
            act["html"] = body["html"]
        if body.get("text"):
            act["text"] = body["text"]
        await _publish(mid, act)
        return {"status": "screen_shown", "meeting_id": mid}

    @router.delete("/bots/{platform}/{native_meeting_id}/screen")
    async def screen_stop(
        platform: str,
        native_meeting_id: str,
        x_user_id: Optional[str] = Header(default=None),
    ):
        mid = await _resolve_meeting_id(platform, native_meeting_id, x_user_id)
        await _publish(mid, {"action": "screen_stop"})
        return {"status": "screen_stopped", "meeting_id": mid}

    return router
