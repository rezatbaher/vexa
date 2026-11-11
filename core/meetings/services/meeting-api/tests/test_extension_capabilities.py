import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.lifecycle.extension import build_extension_router


def client(tmp_path, *, enabled=True, manifest=True):
    build = tmp_path / "build.json"
    if manifest:
        build.write_text(json.dumps({"source_revision": "a" * 40, "bot_commands": [
            "speak_stream", "chat_stream", "meeting_control", "presentation_show", "presentation_stop"]}))
    app = FastAPI()
    app.include_router(build_extension_router(object(), object(), enabled=enabled, build_path=build))
    return TestClient(app)


def test_capabilities_require_gateway_identity(tmp_path):
    assert client(tmp_path).get("/bots/capabilities").status_code == 401


def test_wired_extension_reports_build_contract_without_claiming_applied_state(tmp_path):
    response = client(tmp_path).get("/bots/capabilities", headers={"x-user-id": "7"})
    assert response.status_code == 200
    data = response.json()
    assert data["extension_protocol"] == "pathwarden-meeting.v1"
    assert data["source_revision"] == "a" * 40
    assert "per-bot" in data["scope"]


def test_absent_extension_does_not_advertise_or_mount_custom_commands(tmp_path):
    api = client(tmp_path, enabled=False)
    data = api.get("/bots/capabilities", headers={"x-user-id": "7"}).json()
    assert data["server_enabled"] is False
    assert data["extension_protocol"] is None
    assert api.post("/bots/google_meet/abc-defg-hij/speak").status_code == 404


def test_unstamped_development_build_fails_closed(tmp_path):
    data = client(tmp_path, manifest=False).get("/bots/capabilities", headers={"x-user-id": "7"}).json()
    assert data["extension_protocol"] is None
    assert data["expected_bot_commands"] == []


def test_unified_app_without_extension_keeps_the_standard_meeting_surface():
    from meeting_api.app import create_app

    api = TestClient(create_app(pathwarden_extension=False))
    assert api.get("/health").status_code == 200
    assert api.get("/bots", headers={"x-user-id": "7"}).status_code == 200
    assert api.post("/bots/google_meet/abc-defg-hij/speak").status_code == 404
    assert api.get("/bots/capabilities", headers={"x-user-id": "7"}).json()["extension_protocol"] is None
