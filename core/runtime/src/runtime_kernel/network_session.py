"""The optional private namespace lease boundary; public runtime.v1 remains unchanged."""
from __future__ import annotations

import importlib.util
import os
import threading
import time
from pathlib import Path


def _contract():
    for root in Path(__file__).resolve().parents:
        for relative in ("contracts/network-session.v1/verification.py", "runtime/contracts/network-session.v1/verification.py"):
            path = root / relative
            if path.is_file():
                spec = importlib.util.spec_from_file_location("vexa_network_session_contract", path)
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                return module
    raise RuntimeError("network-session.v1 contract is absent")


contract = _contract()


class NetworkSessions:
    def __init__(self, expire, *, clock=time.time):
        self._expire, self._clock = expire, clock
        self._lock = threading.Lock()
        self._active = {}
        self._timers = {}

    def enabled(self, backend):
        if backend != "docker" or os.getenv("VEXA_NETWORK_SESSION_ENABLED", "false").lower() != "true":
            return False
        try:
            contract.public_key(os.getenv(contract.PUBLIC_KEY_ENV, ""))
            return True
        except ValueError:
            return False

    def authorize(self, token, backend):
        if not self.enabled(backend):
            raise ValueError("This runtime does not support personal network sessions")
        return contract.verify(token, os.environ[contract.PUBLIC_KEY_ENV], now=int(self._clock()))

    def accept(self, workload_id, claims):
        with self._lock:
            if claims["exp"]<=self._clock():
                raise ValueError("Personal network authority expired before workload start")
            previous = self._active.get(workload_id)
            if previous and (previous["exp"] <= self._clock() or not contract.same_binding(previous, claims)):
                raise ValueError("Personal network binding cannot change or resume after expiry")
            if previous and previous["exp"] >= claims["exp"]:
                return
            self._active[workload_id] = claims
            timer = self._timers.pop(workload_id, None)
            if timer:
                timer.cancel()
            timer = threading.Timer(max(0, claims["exp"] - self._clock()), self._expired, args=(workload_id, claims["exp"]))
            timer.daemon = True
            self._timers[workload_id] = timer
            timer.start()

    def current(self, workload_id):
        with self._lock:
            return self._active.get(workload_id)

    def _expired(self, workload_id, expiry):
        with self._lock:
            claims = self._active.get(workload_id)
            if not claims or claims["exp"] != expiry or expiry > self._clock():
                return
            self._timers.pop(workload_id, None)
        self._expire(workload_id)

    def remove(self, workload_id):
        with self._lock:
            timer = self._timers.pop(workload_id, None)
            if timer:
                timer.cancel()
            self._active.pop(workload_id, None)
