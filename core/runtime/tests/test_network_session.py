"""Private networking proves signature, namespace isolation, sticky renewal and expiry."""

import base64
import json
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from runtime_kernel import Runtime
from runtime_kernel.kernel import StartFailed, QuotaExceeded
from runtime_kernel.api import create_app
from runtime_kernel.docker_backend import DockerBackend, _in_stack_network
from runtime_kernel.models import WorkloadSpec
from runtime_kernel.network_session import NetworkSessions, contract
from runtime_kernel.profiles import Runnable
from fastapi.testclient import TestClient


def signed(key, claims):
    encode = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip("=")
    raw = (
        encode(b'{"alg":"EdDSA","typ":"JWT"}')
        + "."
        + encode(json.dumps(claims).encode())
    )
    return raw + "." + encode(key.sign(raw.encode()))


@pytest.fixture
def authority(monkeypatch):
    key = Ed25519PrivateKey.generate()
    encoded = base64.b64encode(
        key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
    ).decode()
    monkeypatch.setenv("VEXA_NETWORK_SESSION_ENABLED", "true")
    monkeypatch.setenv("VEXA_NETWORK_SESSION_PUBLIC_KEY", encoded)
    monkeypatch.setenv("DOCKER_NETWORK", "vexa-test-stack")
    session = str(uuid.uuid4())
    stamp = int(time.time())
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
    return key, encoded, claims


class FakeDocker(DockerBackend):
    def __init__(self, claims):
        super().__init__()
        self.claims = claims
        self.calls = []
        self.running = True
        self.gateway = {
            "Id": "a" * 64,
            "State": {"Running": True},
            "Config": {
                "Labels": {
                    "pathwarden.network_session": claims["session"],
                    "pathwarden.network_owner": claims["owner"],
                    "pathwarden.network_generation": "1",
                }
            },
            "HostConfig": {"NetworkMode": "none", "Dns": ["127.0.0.1"]},
            "NetworkSettings": {"Networks": {"none": {}}},
        }

    def _req(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        status, body = 204, {}
        if method == "GET" and path == f"/containers/{self.claims['gateway']}/json":
            status, body = 200, self.gateway
        elif path.startswith("/containers/create"):
            status, body = 201, {"Id": "b" * 64}
        elif method == "GET" and path.endswith("/json"):
            status, body = (
                200,
                {
                    "Config": {
                        "Labels": {
                            "runtime.managed": "true",
                            "runtime.network_session": self.claims["session"],
                            "runtime.network_stack": "vexa-test-stack",
                        }
                    },
                    "HostConfig": {"NetworkMode": "container:" + "a" * 64},
                    "State": {"Running": self.running, "ExitCode": 137},
                },
            )
        elif "/stop" in path or "/kill" in path:
            self.running = False
        return SimpleNamespace(
            status_code=status, json=lambda: body, text="synthetic Docker response"
        )


def test_signature_and_scope_are_checked_before_any_spawn(authority):
    key, encoded, claims = authority
    token = signed(key, claims)
    assert contract.verify(token, encoded) == claims
    for change in (
        {"aud": "other"},
        {"owner": "not-a-uuid"},
        {"exp": claims["iat"] + 16},
        {"exp": claims["iat"]},
        {"generation": True},
    ):
        with pytest.raises(ValueError):
            contract.verify(signed(key, {**claims, **change}), encoded)
    with pytest.raises(ValueError):
        contract.verify(token, encoded, expected_workload={"platform": "teams"})
    with pytest.raises(ValueError):
        contract.verify(token[:-2] + "xx", encoded)


def test_bot_has_only_gateway_namespace_and_no_lease_in_worker_or_store(authority):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(backend=backend, profiles={"test": Runnable(image="test-image")})
    token = signed(key, claims)
    try:
        rt.create(
            WorkloadSpec(
                workloadId="meeting",
                profile="test",
                env={contract.ENV: token, "VISIBLE": "yes"},
            )
        )
        payload = next(
            kwargs["json"]
            for method, path, kwargs in backend.calls
            if path.startswith("/containers/create")
        )
        assert payload["HostConfig"]["NetworkMode"] == "container:" + "a" * 64
        assert (
            "Dns" not in payload["HostConfig"]
            and "ExtraHosts" not in payload["HostConfig"]
        )
        assert payload["Env"] == ["VISIBLE=yes"]
        assert contract.ENV not in rt.store.get("meeting").spec.env
        assert "VISIBLE" in rt.store.get("meeting").spec.env
    finally:
        rt.network_sessions.remove("meeting")


@pytest.mark.parametrize("change", ["owner", "generation", "app_network", "dns"])
def test_gateway_identity_and_isolation_must_match(authority, change):
    key, _, claims = authority
    backend = FakeDocker(claims)
    if change == "owner":
        backend.gateway["Config"]["Labels"]["pathwarden.network_owner"] = str(
            uuid.uuid4()
        )
    if change == "generation":
        backend.gateway["Config"]["Labels"]["pathwarden.network_generation"] = "2"
    if change == "app_network":
        backend.gateway["NetworkSettings"]["Networks"]["app"] = {}
    if change == "dns":
        backend.gateway["HostConfig"]["Dns"] = ["8.8.8.8"]
    with pytest.raises(ValueError):
        backend.start(
            "meeting", Runnable(image="test"), {contract.ENV: signed(key, claims)}
        )
    assert not any(
        path.startswith("/containers/create") for _, path, _ in backend.calls
    )


def test_runtime_lease_expiry_stops_workload_and_cannot_resume(authority):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(backend=backend, profiles={"test": Runnable(image="test-image")})
    rt.create(
        WorkloadSpec(
            workloadId="meeting",
            profile="test",
            env={contract.ENV: signed(key, claims)},
        )
    )
    rt.network_sessions._clock = lambda: claims["exp"]
    rt.network_sessions._expired("meeting", claims["exp"])
    assert not backend.running
    assert rt.get("meeting").state.value == "stopped"
    with pytest.raises(ValueError):
        rt.renew_network(
            "meeting",
            signed(key, {**claims, "iat": claims["iat"] + 1, "exp": claims["exp"] + 1}),
        )


def test_renewal_is_sticky_and_an_expired_lease_cannot_be_revived(authority):
    _, _, claims = authority
    clock = [claims["iat"]]
    sessions = NetworkSessions(lambda _: None, clock=lambda: clock[0])
    try:
        sessions.accept("meeting", claims)
        with pytest.raises(ValueError):
            sessions.accept("meeting", {**claims, "owner": str(uuid.uuid4())})
        clock[0] = claims["exp"]
        with pytest.raises(ValueError):
            sessions.accept(
                "meeting", {**claims, "iat": claims["exp"], "exp": claims["exp"] + 15}
            )
    finally:
        sessions.remove("meeting")


def test_health_advertises_only_qualified_runtime_and_process_refuses(
    authority, monkeypatch
):
    key, _, claims = authority
    rt = Runtime(backend=FakeDocker(claims), profiles={"test": Runnable(image="test")})
    assert (
        TestClient(create_app(rt, deliver=lambda _: None))
        .get("/health")
        .json()["network_session"]
        == contract.PROTOCOL
    )
    plain = Runtime(profiles={"test": ["sleep", "30"]})
    assert (
        TestClient(create_app(plain, deliver=lambda _: None))
        .get("/health")
        .json()["network_session"]
        is None
    )
    with pytest.raises(ValueError):
        plain.create(
            WorkloadSpec(
                workloadId="meeting",
                profile="test",
                env={contract.ENV: signed(key, claims)},
            )
        )
    monkeypatch.delenv("VEXA_NETWORK_SESSION_PUBLIC_KEY")
    assert (
        TestClient(create_app(rt, deliver=lambda _: None))
        .get("/health")
        .json()["network_session"]
        is None
    )


def test_shared_namespace_remains_stack_scoped():
    body = {
        "HostConfig": {"NetworkMode": "container:" + "a" * 64},
        "Config": {
            "Labels": {
                "runtime.managed": "true",
                "runtime.network_session": str(uuid.uuid4()),
                "runtime.network_stack": "stack-a",
            }
        },
    }
    assert _in_stack_network("stack-a", body)
    assert not _in_stack_network("stack-b", body)


@pytest.mark.parametrize("reserved", [False, True])
def test_expiry_during_uncertain_docker_start_cannot_leave_live_bot(
    authority, reserved
):
    key, _, claims = authority
    backend = FakeDocker(claims)
    profile = "meeting-bot" if reserved else "test"
    rt = Runtime(backend=backend, profiles={profile: Runnable(image="test")})
    workload = "mtg-expiring" if reserved else "meeting"
    spec = WorkloadSpec(
        workloadId=workload, profile=profile, env={contract.ENV: signed(key, claims)}
    )
    if reserved:
        ticket = rt.reserve_network(signed(key, claims), "vexa-user-7", create=True)[
            "ticket"
        ]
        plain = spec.model_copy(update={"env": {}})
        envelope = rt.seal_network(ticket, "vexa-user-7", plain)["reservation"]
        spec = plain.model_copy(update={"env": {contract.RESERVATION_ENV: envelope}})
    start = backend.start

    def delayed_start(*args, **kwargs):
        handle = start(*args, **kwargs)
        rt.network_sessions._clock = lambda: claims["exp"]
        rt.network_sessions._expired(workload, claims["exp"])
        return handle

    backend.start = delayed_start
    with pytest.raises(StartFailed):
        rt.create(spec)
    assert not backend.running
    assert rt.get(workload).state.value == "stopped"


def test_runtime_restart_stops_routed_bots_without_retained_authority(authority):
    _, _, claims = authority
    backend = FakeDocker(claims)
    backend.list_workload_containers = lambda: [
        {
            "workload_id": "meeting",
            "name": "vexa-meeting",
            "running": True,
            "network_session": True,
        }
    ]
    rt = Runtime(backend=backend)
    assert rt.adopt() == 1
    assert not backend.running
    assert rt.get("meeting").state.value == "stopped"


def test_reservation_pins_caller_spec_generation_and_cannot_revive(authority):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(
        backend=backend, profiles={"meeting-bot": Runnable(image="test-image")}
    )
    reserved = rt.reserve_network(signed(key, claims), "vexa-user-7", create=True)
    spec = WorkloadSpec(
        workloadId="mtg-1-session",
        profile="meeting-bot",
        env={"VEXA_BOT_CONFIG": "selected"},
    )
    envelope = rt.seal_network(reserved["ticket"], "vexa-user-7", spec)["reservation"]
    for change in (
        {"profile": "other"},
        {"env": {"VEXA_BOT_CONFIG": "changed"}},
        {"workloadId": "mtg-another"},
    ):
        with pytest.raises(ValueError):
            rt.network_sessions.consume(envelope, spec.model_copy(update=change))
    with pytest.raises(ValueError):
        rt.seal_network(reserved["ticket"], "vexa-user-8", spec)
    with pytest.raises(ValueError):
        rt.reserve_network(signed(key, {**claims, "generation": 2}), "vexa-user-7")
    assert rt.network_sessions.consume(envelope, spec)["claims"] == claims
    with pytest.raises(ValueError):
        rt.network_sessions.consume(envelope, spec)
    rt.network_sessions._clock = lambda: claims["exp"]
    with pytest.raises(ValueError):
        rt.seal_network(reserved["ticket"], "vexa-user-7", spec)
    future = {**claims, "iat": claims["exp"], "exp": claims["exp"] + 15}
    with pytest.raises(ValueError):
        rt.network_sessions.reserve(
            future,
            signed(key, future),
            "vexa-user-7",
            "container:" + "a" * 64,
            create=True,
        )


def test_consumed_ticket_touches_only_its_live_exact_workload(authority):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(backend=backend, profiles={"meeting-bot": Runnable(image="test")})
    plain = WorkloadSpec(
        workloadId="mtg-touch", profile="meeting-bot", env={"SELECTED": "yes"}
    )
    ticket = rt.reserve_network(signed(key, claims), "caller", create=True)["ticket"]
    envelope = rt.seal_network(ticket, "caller", plain)["reservation"]
    spec = plain.model_copy(
        update={"env": {**plain.env, contract.RESERVATION_ENV: envelope}}
    )
    try:
        assert rt.create(spec).state.value == "running"
        assert rt.create(spec).state.value == "running"
        assert (
            sum(path.startswith("/containers/create") for _, path, _ in backend.calls)
            == 1
        )
        with pytest.raises(ValueError):
            rt.create(
                spec.model_copy(update={"env": {**spec.env, "SELECTED": "different"}})
            )
        rt.stop(spec.workloadId)
        with pytest.raises(ValueError):
            rt.create(spec)
        assert (
            sum(path.startswith("/containers/create") for _, path, _ in backend.calls)
            == 1
        )
    finally:
        rt.network_sessions.remove(spec.workloadId)


def test_daemon_absence_does_not_make_a_timeout_safe_to_replay():
    backend = DockerBackend()
    calls = []

    def refused(method, path, **kwargs):
        calls.append((method, path))
        return SimpleNamespace(
            status_code=404, text="synthetic daemon rejection", json=lambda: {}
        )

    backend._req = refused
    assert not backend.creation_absent(
        "mtg-unknown", TimeoutError("delivery uncertain")
    )
    assert not calls
    with pytest.raises(RuntimeError) as rejected:
        backend.start("mtg-rejected", Runnable(image="missing-validation-image"), {})
    assert backend.creation_absent("mtg-rejected", rejected.value)
    assert [method for method, _ in calls] == ["POST", "GET"]


def test_quota_rejection_does_not_burn_a_never_submitted_ticket(authority):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(
        backend=backend, profiles={"meeting-bot": Runnable(image="test")}, owner_quota=0
    )
    plain = WorkloadSpec(workloadId="mtg-quota", profile="meeting-bot", env={})
    ticket = rt.reserve_network(signed(key, claims), "caller", create=True)["ticket"]
    envelope = rt.seal_network(ticket, "caller", plain)["reservation"]
    spec = plain.model_copy(update={"env": {contract.RESERVATION_ENV: envelope}})
    with pytest.raises(QuotaExceeded):
        rt.create(spec)
    assert not any(
        path.startswith("/containers/create") for _, path, _ in backend.calls
    )
    rt.owner_quota = 1
    try:
        assert rt.create(spec).state.value == "running"
        assert (
            sum(path.startswith("/containers/create") for _, path, _ in backend.calls)
            == 1
        )
    finally:
        rt.network_sessions.remove(plain.workloadId)


@pytest.mark.parametrize("partial_write", [False, True])
def test_pre_submission_store_failure_allows_explicit_retry_without_stale_starting_record(
    authority, monkeypatch, partial_write
):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(
        backend=backend, profiles={"meeting-bot": Runnable(image="test")}, owner_quota=1
    )
    plain = WorkloadSpec(workloadId="mtg-store-failure", profile="meeting-bot", env={})
    token = signed(key, claims)
    ticket = rt.reserve_network(token, "caller", create=True)["ticket"]
    envelope = rt.seal_network(ticket, "caller", plain)["reservation"]
    original = rt.store.set
    failed = False

    def fail_once(record):
        nonlocal failed
        if not failed and record.status.state.value == "starting":
            failed = True
            if partial_write:
                original(record)
            raise RuntimeError("synthetic pre-submission store failure")
        original(record)

    monkeypatch.setattr(rt.store, "set", fail_once)
    with pytest.raises(RuntimeError):
        rt.create(
            plain.model_copy(update={"env": {contract.RESERVATION_ENV: envelope}})
        )
    assert not any(
        path.startswith("/containers/create") for _, path, _ in backend.calls
    )
    replacement = rt.reserve_network(token, "caller", create=True)["ticket"]
    assert replacement != ticket
    retry = rt.seal_network(replacement, "caller", plain)["reservation"]
    try:
        retried = plain.model_copy(update={"env": {contract.RESERVATION_ENV: retry}})
        assert rt.create(retried).state.value == "running"
        assert rt.create(retried).state.value == "running"
        assert (
            sum(path.startswith("/containers/create") for _, path, _ in backend.calls)
            == 1
        )
    finally:
        rt.network_sessions.remove(plain.workloadId)


@pytest.mark.parametrize("known_absent", [True, False])
def test_failed_attempt_retries_only_after_confirmed_absence_and_explicit_new_ticket(
    authority, known_absent
):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(backend=backend, profiles={"meeting-bot": Runnable(image="test")})
    backend.creation_absent = lambda _workload, _failure: known_absent
    plain = WorkloadSpec(workloadId="mtg-retry", profile="meeting-bot", env={})
    token = signed(key, claims)
    ticket = rt.reserve_network(token, "caller", create=True)["ticket"]
    envelope = rt.seal_network(ticket, "caller", plain)["reservation"]
    spec = plain.model_copy(update={"env": {contract.RESERVATION_ENV: envelope}})
    original = backend.start
    backend.start = lambda *args, **kwargs: (_ for _ in ()).throw(
        RuntimeError("synthetic daemon creation failure")
    )
    with pytest.raises(StartFailed):
        rt.create(spec)
    assert not any(
        path.startswith("/containers/create") for _, path, _ in backend.calls
    )
    with pytest.raises(ValueError):
        rt.create(spec)
    if not known_absent:
        with pytest.raises(ValueError):
            rt.reserve_network(token, "caller", create=True)
        return
    assert rt.reserve_network(token, "caller")["renewed"]
    assert not any(
        path.startswith("/containers/create") for _, path, _ in backend.calls
    )
    fresh = rt.reserve_network(token, "caller", create=True)["ticket"]
    assert fresh != ticket
    fresh_envelope = rt.seal_network(fresh, "caller", plain)["reservation"]
    backend.start = original
    try:
        assert (
            rt.create(
                plain.model_copy(
                    update={"env": {contract.RESERVATION_ENV: fresh_envelope}}
                )
            ).state.value
            == "running"
        )
        assert (
            sum(path.startswith("/containers/create") for _, path, _ in backend.calls)
            == 1
        )
    finally:
        rt.network_sessions.remove(plain.workloadId)


@pytest.mark.parametrize("phase", ["admission", "docker"])
def test_real_slow_start_over_fifteen_seconds_renews_without_stale_jwt(
    authority, phase
):
    key, _, claims = authority
    backend = FakeDocker(claims)
    rt = Runtime(
        backend=backend, profiles={"meeting-bot": Runnable(image="test-image")}
    )
    ticket = rt.reserve_network(signed(key, claims), "vexa-user-7", create=True)[
        "ticket"
    ]
    spec = WorkloadSpec(
        workloadId="mtg-slow-session",
        profile="meeting-bot",
        env={"VEXA_BOT_CONFIG": "selected"},
    )
    entered, release = threading.Event(), threading.Event()
    original = backend._req

    def delayed_request(method, path, **kwargs):
        if (
            phase == "docker"
            and method == "POST"
            and path.startswith("/containers/create")
        ):
            entered.set()
            assert release.wait(25)
        return original(method, path, **kwargs)

    backend._req = delayed_request
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = None
        try:
            if phase == "docker":
                envelope = rt.seal_network(ticket, "vexa-user-7", spec)["reservation"]
                future = pool.submit(
                    rt.create,
                    spec.model_copy(
                        update={"env": {**spec.env, contract.RESERVATION_ENV: envelope}}
                    ),
                )
                assert entered.wait(2)
            for _ in range(4):
                time.sleep(4)
                now = int(time.time())
                rt.reserve_network(
                    signed(key, {**claims, "iat": now, "exp": now + 15}), "vexa-user-7"
                )
            assert int(time.time()) >= claims["exp"], (
                "test must outlive the original signed JWT"
            )
            if phase == "admission":
                envelope = rt.seal_network(ticket, "vexa-user-7", spec)["reservation"]
                future = pool.submit(
                    rt.create,
                    spec.model_copy(
                        update={"env": {**spec.env, contract.RESERVATION_ENV: envelope}}
                    ),
                )
            release.set()
            assert future.result(timeout=3).state.value == "running"
            assert rt.network_sessions.current(spec.workloadId)["exp"] > time.time()
            assert not any(
                key in rt.store.get(spec.workloadId).spec.env
                for key in (
                    contract.ENV,
                    contract.RESERVATION_ENV,
                    contract.NAMESPACE_ENV,
                )
            )
        finally:
            release.set()
            rt.network_sessions.remove(spec.workloadId)
