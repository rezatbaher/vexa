"""The actual HTTP handler publishes signed delivery, isolated to the provider account."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.lifecycle.voice_router import build_voice_router

ID = "eebdcafb-a202-41e3-aadc-a0ee49f09028"
TOKEN = "fake.header.signature"


class Repo:
    async def find_active(self, user_id, platform, native):
        return {"id": 401} if user_id == 7 and platform == "google_meet" and native == "abc-defg-hij" else None


class Publisher:
    def __init__(self):
        self.sent = []

    async def publish(self, channel, value):
        self.sent.append((channel, json.loads(value)))


@pytest.mark.parametrize("delivery,action", [("voice", "speak_stream"), ("chat", "chat_stream")])
def test_signed_delivery_and_account_boundary(delivery, action):
    publisher = Publisher()
    app = FastAPI()
    app.include_router(build_voice_router(Repo(), publisher))
    with TestClient(app) as client:
        payload = {"speech_id": ID, "stream_token": TOKEN, "delivery": delivery}
        url = "/bots/google_meet/abc-defg-hij/speak"
        assert client.post(url, json=payload, headers={"x-user-id": "8"}).status_code == 404
        assert publisher.sent == []
        response = client.post(url, json=payload, headers={"x-user-id": "7"})
        assert response.status_code == 202
        assert response.json()["status"] == "accepted"
        assert publisher.sent == [("bot_commands:meeting:401", {"action": action, "speech_id": ID, "stream_token": TOKEN})]
        publisher.sent.clear()
        for bad in ({**payload, "speech_id": "bad"}, {**payload, "stream_token": "not-a-capability"}, {**payload, "delivery": "unsupported"}):
            assert client.post(url, json=bad, headers={"x-user-id": "7"}).status_code == 422
        assert publisher.sent == []


def test_room_controls_and_presentations_are_typed_requests_not_success_claims():
    publisher = Publisher()
    app = FastAPI()
    app.include_router(build_voice_router(Repo(), publisher))
    url = "/bots/google_meet/abc-defg-hij/speak"
    with TestClient(app) as client:
        headers = {"x-user-id": "7"}
        control = {"request_id": ID, "revision": 1, "notes_enabled": False}
        response = client.post(url, json={"control": control}, headers=headers)
        assert response.status_code == 202 and response.json()["status"] == "accepted"
        assert publisher.sent[-1][1] == {"action": "meeting_control", **control}
        for bad in ({**control, "notes_enabled": "false"}, {**control, "revision": True}, {**control, "request_id": "bad"}):
            assert client.post(url, json={"control": bad}, headers=headers).status_code == 422
        show = {"presentation_id": ID, "token": TOKEN, "room_revision": "room", "page": 1, "sequence": 2}
        assert client.post(url, json={"presentation": show}, headers=headers).json()["status"] == "requested"
        assert publisher.sent[-1][1] == {"action": "presentation_show", **show}
        assert client.post(url, json={"presentation": {"stop": True, "sequence": 3}}, headers=headers).json()["status"] == "stop_requested"
        assert publisher.sent[-1][1] == {"action": "presentation_stop", "sequence": 3}
        assert client.post(url, json={"presentation": {"stop": True}}, headers=headers).status_code == 422
        assert client.post(url, json={"avatar": True}, headers=headers).json()["status"] == "requested"
        assert publisher.sent[-1][1] == {"action": "avatar_set", "url": "voxai:default"}
        assert client.post(url, json={"avatar": "true"}, headers=headers).status_code == 422
        before = len(publisher.sent)
        assert client.post(url, json={"control": control}, headers={"x-user-id": "8"}).status_code == 404
        assert len(publisher.sent) == before
