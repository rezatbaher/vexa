"""The optional private namespace lease boundary; public runtime.v1 remains unchanged."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path


def _contract():
    for root in Path(__file__).resolve().parents:
        for relative in (
            "contracts/network-session.v1/verification.py",
            "runtime/contracts/network-session.v1/verification.py",
        ):
            path = root / relative
            if path.is_file():
                spec = importlib.util.spec_from_file_location(
                    "vexa_network_session_contract", path
                )
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
        self._reservations = {}
        self._tickets = {}
        self._ended = {}

    def reserve(self, claims, token, requester, namespace, *, create=False):
        if not isinstance(requester, str) or not requester or len(requester) > 128:
            raise ValueError("A verified requester is required")
        with self._lock:
            for session, previous in list(self._reservations.items()):
                if previous["claims"]["exp"] <= self._clock():
                    self._reservations.pop(session)
                    self._tickets.pop(previous["ticket"], None)
                    self._ended[session] = True
            while len(self._ended) > 4096:
                self._ended.pop(next(iter(self._ended)))
            row = self._reservations.get(claims["session"])
            if row is None:
                if claims["session"] in self._ended:
                    raise ValueError(
                        "An expired provisional network session cannot be revived"
                    )
                if not create:
                    raise KeyError("Unknown provisional network session")
                if len(self._reservations) >= 1024:
                    raise ValueError("Network reservation capacity reached")
                ticket = secrets.token_urlsafe(32)
                row = {
                    "claims": claims,
                    "token": token,
                    "requester": requester,
                    "namespace": namespace,
                    "ticket": ticket,
                    "digest": None,
                    "workload": None,
                    "consumed": False,
                }
                self._reservations[claims["session"]] = row
                self._tickets[ticket] = row
            elif row["claims"]["exp"] <= self._clock():
                raise ValueError(
                    "An expired provisional network session cannot be revived"
                )
            if (
                row["requester"] != requester
                or row["namespace"] != namespace
                or not contract.same_binding(row["claims"], claims)
            ):
                raise ValueError("Provisional network session affinity differs")
            if claims["exp"] <= self._clock():
                raise ValueError("Provisional network authority expired")
            if create and row["ticket"] is None:
                row["ticket"] = secrets.token_urlsafe(32)
                self._tickets[row["ticket"]] = row
            if claims["exp"] > row["claims"]["exp"]:
                row["claims"], row["token"] = claims, token
            return dict(row)

    def seal(self, ticket, requester, spec):
        with self._lock:
            row = self._ticket(ticket, requester)
            if spec.profile != "meeting-bot" or not spec.workloadId.startswith("mtg-"):
                raise ValueError(
                    "A reservation authorizes only the selected meeting-bot profile"
                )
            digest = self._spec_digest(spec)
            if row["digest"] is not None and (
                row["digest"] != digest or row["workload"] != spec.workloadId
            ):
                raise ValueError(
                    "A network ticket cannot authorize a different workload"
                )
            row["digest"], row["workload"] = digest, spec.workloadId
            return json.dumps(
                {"ticket": ticket, "requester": requester}, separators=(",", ":")
            )

    def consume(self, envelope, spec, *, touch=False):
        try:
            value = json.loads(envelope)
        except (TypeError, ValueError):
            raise ValueError("Invalid private network reservation") from None
        if not isinstance(value, dict) or set(value) != {"ticket", "requester"}:
            raise ValueError("Invalid private network reservation")
        with self._lock:
            row = self._ticket(value["ticket"], value["requester"])
            if (
                row["digest"] != self._spec_digest(spec)
                or row["workload"] != spec.workloadId
            ):
                raise ValueError(
                    "The network ticket does not authorize this workload specification"
                )
            if row["consumed"] and not touch:
                raise ValueError("The private network ticket has already been consumed")
            row["consumed"] = True
            return dict(row)

    def _ticket(self, ticket, requester):
        row = self._tickets.get(ticket) if isinstance(ticket, str) else None
        if (
            not row
            or row["requester"] != requester
            or row["claims"]["exp"] <= self._clock()
        ):
            raise ValueError("Private network reservation is unavailable or expired")
        return row

    @staticmethod
    def _spec_digest(spec):
        value = spec.model_dump(mode="json", exclude_none=True)
        value["env"] = {
            key: item
            for key, item in value["env"].items()
            if key
            not in (contract.ENV, contract.RESERVATION_ENV, contract.NAMESPACE_ENV)
        }
        return hashlib.sha256(
            json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()

    def enabled(self, backend):
        if (
            backend != "docker"
            or os.getenv("VEXA_NETWORK_SESSION_ENABLED", "false").lower() != "true"
        ):
            return False
        try:
            contract.public_key(os.getenv(contract.PUBLIC_KEY_ENV, ""))
            return True
        except ValueError:
            return False

    def authorize(self, token, backend):
        if not self.enabled(backend):
            raise ValueError("This runtime does not support personal network sessions")
        return contract.verify(
            token, os.environ[contract.PUBLIC_KEY_ENV], now=int(self._clock())
        )

    def accept(self, workload_id, claims):
        with self._lock:
            if claims["exp"] <= self._clock():
                raise ValueError(
                    "Personal network authority expired before workload start"
                )
            previous = self._active.get(workload_id)
            if previous and (
                previous["exp"] <= self._clock()
                or not contract.same_binding(previous, claims)
            ):
                raise ValueError(
                    "Personal network binding cannot change or resume after expiry"
                )
            if previous and previous["exp"] >= claims["exp"]:
                return
            self._active[workload_id] = claims
            timer = self._timers.pop(workload_id, None)
            if timer:
                timer.cancel()
            timer = threading.Timer(
                max(0, claims["exp"] - self._clock()),
                self._expired,
                args=(workload_id, claims["exp"]),
            )
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

    def remove(self, workload_id, *, failed_start=False):
        with self._lock:
            timer = self._timers.pop(workload_id, None)
            if timer:
                timer.cancel()
            active = self._active.pop(workload_id, None)
            for session, row in list(self._reservations.items()):
                if row["workload"] == workload_id:
                    self._tickets.pop(row["ticket"], None)
                    if failed_start and active and active["exp"] > self._clock():
                        # A failed creation attempt burns its ticket, while the still-authorized
                        # sticky session can issue a new ticket for an explicit later attempt.
                        row.update(
                            ticket=None, workload=None, digest=None, consumed=False
                        )
                    else:
                        self._reservations.pop(session)
                        self._ended[session] = True
