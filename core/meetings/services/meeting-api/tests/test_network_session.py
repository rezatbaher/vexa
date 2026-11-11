"""Private personal-network admission preserves meeting uniqueness and runtime affinity."""

import base64
import asyncio
import json
import os
import time
import uuid

import pytest
import httpx
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo, FakeRuntimeClient
from meeting_api.bot_spawn.router import build_router
from meeting_api.bot_spawn.network_session import contract
from meeting_api.collector.projection import project_response_data
from meeting_api.lifecycle.extension import build_extension_router


def signed(key, claims):
    encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
    body = (
        encode(b'{"alg":"EdDSA","typ":"JWT"}')
        + "."
        + encode(json.dumps(claims).encode())
    )
    return body + "." + encode(key.sign(body.encode()))


class NetworkRuntime(FakeRuntimeClient):
    def __init__(self):
        super().__init__()
        self.protocol = contract.PROTOCOL
        self.renewals = []
        self.reservations = {}
        self.sealed = {}

    async def network_capability(self):
        return self.protocol

    async def renew_network(self, workload_id, token):
        self.renewals.append((workload_id, token))
        return {"renewed": True}

    async def reserve_network(self, token, requester, *, create=False):
        claims = contract.verify(token, os.environ[contract.PUBLIC_KEY_ENV])
        key = claims["session"]
        if key not in self.reservations:
            if not create:
                raise KeyError(key)
            self.reservations[key] = {
                "requester": requester,
                "claims": claims,
                "ticket": "synthetic-private-ticket",
            }
        row = self.reservations[key]
        if row["requester"] != requester or not contract.same_binding(
            row["claims"], claims
        ):
            raise ValueError("wrong caller")
        if not create:
            self.renewals.append((self.sealed.get(row["ticket"]), token))
        return {"ticket": row["ticket"], "renewed": True}

    async def seal_network(self, ticket, requester, spec):
        self.sealed[ticket] = spec["workloadId"]
        return json.dumps({"ticket": ticket, "requester": requester})


@pytest.fixture
def network(monkeypatch):
    key = Ed25519PrivateKey.generate()
    monkeypatch.setenv("VEXA_NETWORK_SESSION_ENABLED", "true")
    monkeypatch.setenv(
        "ADMIN_TOKEN", "synthetic-network-test-admin-token-never-a-credential"
    )
    monkeypatch.setenv(
        "VEXA_NETWORK_SESSION_PUBLIC_KEY",
        base64.b64encode(
            key.public_key().public_bytes(
                serialization.Encoding.Raw, serialization.PublicFormat.Raw
            )
        ).decode(),
    )
    stamp = int(time.time())
    session = str(uuid.uuid4())
    claims = {
        "aud": "pathwarden-vexa-network",
        "session": session,
        "owner": str(uuid.uuid4()),
        "gateway": f"pathwarden-exit-{session}-1",
        "generation": 1,
        "workload": {"platform": "google_meet", "native_meeting_id": "abc-defg-hij"},
        "iat": stamp,
        "exp": stamp + 15,
    }
    repo, runtime = InMemoryMeetingRepo(), NetworkRuntime()
    app = FastAPI()
    app.include_router(build_router(repo, runtime))
    return key, claims, repo, runtime, TestClient(app)


def request(token):
    return {
        "platform": "google_meet",
        "native_meeting_id": "abc-defg-hij",
        "transcribe_enabled": False,
        "recording_enabled": False,
        "authenticated": False,
        "network_lease": token,
    }


def test_network_binding_survives_spawn_and_signed_refresh(network):
    key, claims, repo, runtime, client = network
    token = signed(key, claims)
    response = client.post("/bots", json=request(token), headers={"x-user-id": "7"})
    assert response.status_code == 201, response.text
    data = response.json()["data"]
    assert data["network_session"] == {
        k: claims[k] for k in ("session", "owner", "generation", "gateway")
    }
    assert contract.ENV not in runtime.specs[0]["env"]
    assert contract.RESERVATION_ENV in runtime.specs[0]["env"]
    assert token not in json.dumps(data)
    refresh = client.post(
        "/bots/google_meet/abc-defg-hij/network-lease",
        json={"token": token},
        headers={"x-user-id": "7"},
    )
    assert refresh.status_code == 200, refresh.text
    assert runtime.renewals[0][0] == runtime.specs[0]["workloadId"]
    assert (
        client.post(
            "/bots", json=request(token), headers={"x-user-id": "7"}
        ).status_code
        == 409
    )
    assert len(runtime.specs) == 1
    assert "network_session" not in project_response_data(data, viewer_is_owner=False)


def test_old_runtime_or_wrong_identity_never_creates_meeting(network):
    key, claims, repo, runtime, client = network
    runtime.protocol = None
    response = client.post(
        "/bots", json=request(signed(key, claims)), headers={"x-user-id": "7"}
    )
    assert response.status_code == 503
    assert not runtime.specs
    runtime.protocol = contract.PROTOCOL
    response = client.post(
        "/bots",
        json=request(
            signed(
                key,
                {
                    **claims,
                    "workload": {"platform": "teams", "native_meeting_id": "other"},
                },
            )
        ),
        headers={"x-user-id": "7"},
    )
    assert response.status_code == 403
    assert not runtime.specs
    assert (
        client.post("/bots", json=request(None), headers={"x-user-id": "7"}).status_code
        == 422
    )


def test_renewal_cannot_switch_meeting_owner_or_session(network):
    key, claims, repo, runtime, client = network
    assert (
        client.post(
            "/bots", json=request(signed(key, claims)), headers={"x-user-id": "7"}
        ).status_code
        == 201
    )
    changed = {**claims, "owner": str(uuid.uuid4())}
    response = client.post(
        "/bots/google_meet/abc-defg-hij/network-lease",
        json={"token": signed(key, changed)},
        headers={"x-user-id": "7"},
    )
    assert response.status_code == 409
    assert not runtime.renewals
    assert (
        client.post(
            "/bots/google_meet/abc-defg-hij/network-lease",
            json={"token": signed(key, claims)},
            headers={"x-user-id": "8"},
        ).status_code
        == 404
    )


def test_capability_checks_actual_runtime_support(network):
    _, _, repo, runtime, _ = network
    app = FastAPI()
    app.include_router(
        build_extension_router(repo, None, enabled=False, runtime=runtime)
    )
    client = TestClient(app)
    assert (
        client.get("/bots/capabilities", headers={"x-user-id": "7"}).json()[
            "network_session"
        ]
        == contract.PROTOCOL
    )
    runtime.protocol = None
    assert (
        client.get("/bots/capabilities", headers={"x-user-id": "7"}).json()[
            "network_session"
        ]
        is None
    )


def test_renewal_is_available_before_meeting_row_or_session_exists(
    network, monkeypatch
):
    from meeting_api.bot_spawn import service, network_session

    key, claims, repo, runtime, _ = network
    token = signed(key, claims)

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()

        async def delayed_context(_):
            entered.set()
            await release.wait()
            return {}

        monkeypatch.setattr(service, "_fetch_bot_context", delayed_context)
        task = asyncio.create_task(
            service.request_bot(repo, runtime, user_id=7, **request(token))
        )
        await entered.wait()
        assert await repo.find_active(7, "google_meet", "abc-defg-hij") is None
        renewed = await network_session.renew(
            repo,
            runtime,
            user_id=7,
            platform="google_meet",
            native_meeting_id="abc-defg-hij",
            token=token,
        )
        assert renewed["renewed"]
        assert not runtime.specs
        release.set()
        await task
        assert len(runtime.specs) == 1

    asyncio.run(scenario())


def test_runtime_capability_remains_visible_with_unrelated_degraded_health():
    from meeting_api.bot_spawn.adapters import HttpRuntimeClient

    async def scenario():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(
                    503,
                    json={
                        "network_session": contract.PROTOCOL,
                        "checks": {"redis": "unavailable"},
                    },
                )
            )
        ) as client:
            assert (
                await HttpRuntimeClient(
                    client, "http://runtime.test"
                ).network_capability()
                == contract.PROTOCOL
            )

    asyncio.run(scenario())
