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
