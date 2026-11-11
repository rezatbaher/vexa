"""Private networking proves signature, namespace isolation, sticky renewal and expiry."""
import base64
import json
import time
import uuid
from types import SimpleNamespace

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from runtime_kernel import Runtime
from runtime_kernel.kernel import StartFailed
from runtime_kernel.api import create_app
from runtime_kernel.docker_backend import DockerBackend, _in_stack_network
from runtime_kernel.models import WorkloadSpec
from runtime_kernel.network_session import NetworkSessions, contract
from runtime_kernel.profiles import Runnable
from fastapi.testclient import TestClient


def signed(key, claims):
    encode=lambda raw:base64.urlsafe_b64encode(raw).decode().rstrip("=")
    raw=encode(b'{"alg":"EdDSA","typ":"JWT"}')+"."+encode(json.dumps(claims).encode())
    return raw+"."+encode(key.sign(raw.encode()))


@pytest.fixture
def authority(monkeypatch):
    key=Ed25519PrivateKey.generate()
    encoded=base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)).decode()
    monkeypatch.setenv("VEXA_NETWORK_SESSION_ENABLED","true")
    monkeypatch.setenv("VEXA_NETWORK_SESSION_PUBLIC_KEY",encoded)
    monkeypatch.setenv("DOCKER_NETWORK","vexa-test-stack")
    session=str(uuid.uuid4())
    stamp=int(time.time())
    claims={"aud":"pathwarden-vexa-network","session":session,"owner":str(uuid.uuid4()),"gateway":f"pathwarden-exit-{session}-1","generation":1,"workload":{"platform":"google_meet","native_meeting_id":"abc-defg-hij"},"iat":stamp,"exp":stamp+15}
    return key,encoded,claims


class FakeDocker(DockerBackend):
    def __init__(self,claims):
        super().__init__()
        self.claims=claims
        self.calls=[]
        self.running=True
        self.gateway={"Id":"a"*64,"State":{"Running":True},"Config":{"Labels":{"pathwarden.network_session":claims["session"],"pathwarden.network_owner":claims["owner"],"pathwarden.network_generation":"1"}},"HostConfig":{"NetworkMode":"none","Dns":["127.0.0.1"]},"NetworkSettings":{"Networks":{"none":{}}}}

    def _req(self,method,path,**kwargs):
        self.calls.append((method,path,kwargs))
        status,body=204,{}
        if method=="GET" and path==f"/containers/{self.claims['gateway']}/json":
            status,body=200,self.gateway
        elif path.startswith("/containers/create"):
            status,body=201,{"Id":"b"*64}
        elif method=="GET" and path.endswith("/json"):
            status,body=200,{"Config":{"Labels":{"runtime.managed":"true","runtime.network_session":self.claims["session"],"runtime.network_stack":"vexa-test-stack"}},"HostConfig":{"NetworkMode":"container:"+"a"*64},"State":{"Running":self.running,"ExitCode":137}}
        elif "/stop" in path or "/kill" in path:
            self.running=False
        return SimpleNamespace(status_code=status,json=lambda:body,text="synthetic Docker response")


def test_signature_and_scope_are_checked_before_any_spawn(authority):
    key,encoded,claims=authority
    token=signed(key,claims)
    assert contract.verify(token,encoded)==claims
    for change in ({"aud":"other"},{"owner":"not-a-uuid"},{"exp":claims["iat"]+16},{"exp":claims["iat"]},{"generation":True}):
        with pytest.raises(ValueError):
            contract.verify(signed(key,{**claims,**change}),encoded)
    with pytest.raises(ValueError):
        contract.verify(token,encoded,expected_workload={"platform":"teams"})
    with pytest.raises(ValueError):
        contract.verify(token[:-2]+"xx",encoded)


def test_bot_has_only_gateway_namespace_and_no_lease_in_worker_or_store(authority):
    key,_,claims=authority
    backend=FakeDocker(claims)
    rt=Runtime(backend=backend,profiles={"test":Runnable(image="test-image")})
    token=signed(key,claims)
    try:
        rt.create(WorkloadSpec(workloadId="meeting",profile="test",env={contract.ENV:token,"VISIBLE":"yes"}))
        payload=next(kwargs["json"] for method,path,kwargs in backend.calls if path.startswith("/containers/create"))
        assert payload["HostConfig"]["NetworkMode"]=="container:"+"a"*64
        assert "Dns" not in payload["HostConfig"] and "ExtraHosts" not in payload["HostConfig"]
        assert payload["Env"]==["VISIBLE=yes"]
        assert contract.ENV not in rt.store.get("meeting").spec.env
        assert "VISIBLE" in rt.store.get("meeting").spec.env
    finally:
        rt.network_sessions.remove("meeting")


@pytest.mark.parametrize("change",["owner","generation","app_network","dns"])
def test_gateway_identity_and_isolation_must_match(authority,change):
    key,_,claims=authority
    backend=FakeDocker(claims)
    if change=="owner":backend.gateway["Config"]["Labels"]["pathwarden.network_owner"]=str(uuid.uuid4())
    if change=="generation":backend.gateway["Config"]["Labels"]["pathwarden.network_generation"]="2"
    if change=="app_network":backend.gateway["NetworkSettings"]["Networks"]["app"]={}
    if change=="dns":backend.gateway["HostConfig"]["Dns"]=["8.8.8.8"]
    with pytest.raises(ValueError):backend.start("meeting",Runnable(image="test"),{contract.ENV:signed(key,claims)})
    assert not any(path.startswith("/containers/create") for _,path,_ in backend.calls)


def test_runtime_lease_expiry_stops_workload_and_cannot_resume(authority):
    key,_,claims=authority
    backend=FakeDocker(claims)
    rt=Runtime(backend=backend,profiles={"test":Runnable(image="test-image")})
    rt.create(WorkloadSpec(workloadId="meeting",profile="test",env={contract.ENV:signed(key,claims)}))
    rt.network_sessions._clock=lambda:claims["exp"]
    rt.network_sessions._expired("meeting",claims["exp"])
    assert not backend.running
    assert rt.get("meeting").state.value=="stopped"
    with pytest.raises(ValueError):rt.renew_network("meeting",signed(key,{**claims,"iat":claims["iat"]+1,"exp":claims["exp"]+1}))


def test_renewal_is_sticky_and_an_expired_lease_cannot_be_revived(authority):
    _,_,claims=authority
    clock=[claims["iat"]]
    sessions=NetworkSessions(lambda _:None,clock=lambda:clock[0])
    try:
        sessions.accept("meeting",claims)
        with pytest.raises(ValueError):sessions.accept("meeting",{**claims,"owner":str(uuid.uuid4())})
        clock[0]=claims["exp"]
        with pytest.raises(ValueError):sessions.accept("meeting",{**claims,"iat":claims["exp"],"exp":claims["exp"]+15})
    finally:sessions.remove("meeting")


def test_health_advertises_only_qualified_runtime_and_process_refuses(authority,monkeypatch):
    key,_,claims=authority
    rt=Runtime(backend=FakeDocker(claims),profiles={"test":Runnable(image="test")})
    assert TestClient(create_app(rt,deliver=lambda _:None)).get("/health").json()["network_session"]==contract.PROTOCOL
    plain=Runtime(profiles={"test":["sleep","30"]})
    assert TestClient(create_app(plain,deliver=lambda _:None)).get("/health").json()["network_session"] is None
    with pytest.raises(ValueError):plain.create(WorkloadSpec(workloadId="meeting",profile="test",env={contract.ENV:signed(key,claims)}))
    monkeypatch.delenv("VEXA_NETWORK_SESSION_PUBLIC_KEY")
    assert TestClient(create_app(rt,deliver=lambda _:None)).get("/health").json()["network_session"] is None


def test_shared_namespace_remains_stack_scoped():
    body={"HostConfig":{"NetworkMode":"container:"+"a"*64},"Config":{"Labels":{"runtime.managed":"true","runtime.network_session":str(uuid.uuid4()),"runtime.network_stack":"stack-a"}}}
    assert _in_stack_network("stack-a",body)
    assert not _in_stack_network("stack-b",body)


def test_expiry_during_uncertain_docker_start_cannot_leave_live_bot(authority):
    key,_,claims=authority
    backend=FakeDocker(claims)
    rt=Runtime(backend=backend,profiles={"test":Runnable(image="test")})
    start=backend.start
    def delayed_start(*args,**kwargs):
        handle=start(*args,**kwargs)
        rt.network_sessions._clock=lambda:claims["exp"]
        rt.network_sessions._expired("meeting",claims["exp"])
        return handle
    backend.start=delayed_start
    with pytest.raises(StartFailed):rt.create(WorkloadSpec(workloadId="meeting",profile="test",env={contract.ENV:signed(key,claims)}))
    assert not backend.running
    assert rt.get("meeting").state.value=="stopped"


def test_runtime_restart_stops_routed_bots_without_retained_authority(authority):
    _,_,claims=authority
    backend=FakeDocker(claims)
    backend.list_workload_containers=lambda:[{"workload_id":"meeting","name":"vexa-meeting","running":True,"network_session":True}]
    rt=Runtime(backend=backend)
    assert rt.adopt()==1
    assert not backend.running
    assert rt.get("meeting").state.value=="stopped"
