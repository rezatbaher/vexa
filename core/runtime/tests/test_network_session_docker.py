"""Opt-in daemon acceptance; creates only UUID-named gateway and sleeper containers."""
import base64
import json
import os
import time
import uuid

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from runtime_kernel import Runtime
from runtime_kernel.docker_backend import DockerBackend
from runtime_kernel.models import Resources, WorkloadSpec
from runtime_kernel.network_session import contract
from runtime_kernel.profiles import Runnable


@pytest.mark.skipif(os.getenv("VEXA_REAL_NETWORK_SESSION_TEST") != "1", reason="requires explicitly authorized isolated Docker daemon acceptance")
def test_real_namespace_inherits_gateway_dns_and_hosts_and_expires(monkeypatch):
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    monkeypatch.setenv("VEXA_NETWORK_SESSION_ENABLED", "true")
    monkeypatch.setenv("VEXA_NETWORK_SESSION_PUBLIC_KEY", public)
    monkeypatch.setenv("DOCKER_NETWORK", "vexa-network-validation")
    monkeypatch.setenv("RUNTIME_STOP_GRACE_SEC", "1")
    session, owner = str(uuid.uuid4()), str(uuid.uuid4())
    gateway = f"pathwarden-exit-{session}-1"
    workload = "network-validation-" + session
    image = os.getenv("VEXA_NETWORK_TEST_IMAGE", "python:3.12-slim-bookworm")
    backend = DockerBackend(name_prefix="vexa-network-validation-")
    runtime = Runtime(backend=backend, profiles={"network-validation": Runnable(image=image, command=["python", "-c", "import time; time.sleep(60)"])})
    bot_name = backend._cname(workload)

    def sign(claims):
        encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip("=")
        message = encode(b'{"alg":"EdDSA","typ":"JWT"}') + "." + encode(json.dumps(claims).encode())
        return message + "." + encode(key.sign(message.encode()))

    try:
        created = backend._req("POST", f"/containers/create?name={gateway}", json={
            "Image": image, "Cmd": ["python", "-c", "import time; time.sleep(60)"],
            "Labels": {"pathwarden.network_session": session, "pathwarden.network_owner": owner, "pathwarden.network_generation": "1", "pathwarden.validation": session},
            "HostConfig": {"NetworkMode": "none", "Dns": ["127.0.0.1"], "ExtraHosts": ["allowed-internal.test:127.96.0.1"], "Memory": 64 << 20, "NanoCpus": 100_000_000},
        })
        assert created.status_code == 201, created.text
        assert backend._req("POST", f"/containers/{gateway}/start").status_code == 204
        now = int(time.time())
        claims = {"aud": "pathwarden-vexa-network", "session": session, "owner": owner, "gateway": gateway, "generation": 1,
                  "workload": {"platform": "google_meet", "native_meeting_id": "isolated-validation"}, "iat": now, "exp": now + 15}
        token = sign(claims)
        runtime.create(WorkloadSpec(workloadId=workload, profile="network-validation", env={contract.ENV: token}, resources=Resources(cpu=0.1, memoryMb=64)))
        donor = backend._req("GET", f"/containers/{gateway}/json").json()
        bot = backend._req("GET", f"/containers/{bot_name}/json").json()
        assert bot["State"]["Running"]
        assert bot["HostConfig"]["NetworkMode"] == "container:" + donor["Id"]
        assert not bot["HostConfig"].get("Dns") and not bot["HostConfig"].get("ExtraHosts")
        assert not bot["NetworkSettings"]["Networks"]
        assert bot["ResolvConfPath"] == donor["ResolvConfPath"]
        assert bot["HostsPath"] == donor["HostsPath"]
        assert not any(value.startswith(contract.ENV + "=") for value in bot["Config"]["Env"])
        assert contract.ENV not in runtime.store.get(workload).spec.env
        renewal = {**claims, "iat": int(time.time()), "exp": int(time.time()) + 15}
        runtime.renew_network(workload, sign(renewal))
        with pytest.raises(ValueError):
            runtime.renew_network(workload, sign({**renewal, "owner": str(uuid.uuid4())}))
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if not backend._req("GET", f"/containers/{bot_name}/json").json()["State"]["Running"] and runtime.get(workload).state.value == "stopped":
                break
            time.sleep(0.2)
        else:
            pytest.fail("real container remained running after its signed lease expired")
        assert runtime.get(workload).state.value == "stopped"
    finally:
        runtime.network_sessions.remove(workload)
        backend._req("DELETE", f"/containers/{bot_name}?force=true")
        backend._req("DELETE", f"/containers/{gateway}?force=true")
