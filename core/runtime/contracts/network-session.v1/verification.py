"""Pure verifier for the private network-session.v1 boundary; no environment or I/O side effects."""

from __future__ import annotations

import base64
import json
import re
import time
import uuid

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

PROTOCOL = "pathwarden-network.v1"
ENV = "VEXA_NETWORK_SESSION"
RESERVATION_ENV = "VEXA_NETWORK_RESERVATION"
NAMESPACE_ENV = "VEXA_NETWORK_NAMESPACE"
PUBLIC_KEY_ENV = "VEXA_NETWORK_SESSION_PUBLIC_KEY"


class NetworkSessionError(ValueError):
    pass


def _decode(segment):
    return base64.b64decode(
        segment + "=" * (-len(segment) % 4), altchars=b"-_", validate=True
    )


def public_key(encoded):
    try:
        return Ed25519PublicKey.from_public_bytes(
            base64.b64decode(encoded, validate=True)
        )
    except Exception:
        raise NetworkSessionError(
            "Personal networking needs a configured verification key"
        ) from None


def verify(token, encoded_key, *, now=None, expected_workload=None):
    try:
        if not isinstance(token, str) or not 1 <= len(token) <= 8192:
            raise ValueError
        header, payload, signature = token.split(".")
        if json.loads(_decode(header)) != {"alg": "EdDSA", "typ": "JWT"}:
            raise ValueError
        public_key(encoded_key).verify(
            _decode(signature), (header + "." + payload).encode("ascii")
        )
        claims = json.loads(_decode(payload))
        if not isinstance(claims, dict) or set(claims) != {
            "aud",
            "session",
            "owner",
            "gateway",
            "generation",
            "workload",
            "iat",
            "exp",
        }:
            raise ValueError
        if claims["aud"] != "pathwarden-vexa-network":
            raise ValueError
        for identity in ("session", "owner"):
            if str(uuid.UUID(claims[identity])) != claims[identity]:
                raise ValueError
        if (
            claims["gateway"]
            != f"pathwarden-exit-{claims['session']}-{claims['generation']}"
        ):
            raise ValueError
        if type(claims["generation"]) is not int or claims["generation"] < 1:
            raise ValueError
        workload = claims["workload"]
        if (
            not isinstance(workload, dict)
            or not 1 <= len(workload) <= 8
            or any(
                not isinstance(k, str)
                or not 1 <= len(k) <= 120
                or not isinstance(v, str)
                or not 1 <= len(v) <= 512
                for k, v in workload.items()
            )
        ):
            raise ValueError
        if expected_workload is not None and workload != expected_workload:
            raise ValueError
        stamp = int(time.time()) if now is None else now
        if type(claims["iat"]) is not int or type(claims["exp"]) is not int:
            raise ValueError
        if (
            not 0 <= claims["iat"] <= stamp < claims["exp"]
            or not 1 <= claims["exp"] - claims["iat"] <= 15
        ):
            raise ValueError
        return claims
    except NetworkSessionError:
        raise
    except Exception:
        raise NetworkSessionError(
            "Personal network authority is invalid or expired"
        ) from None


def same_binding(old, new):
    return all(
        old[k] == new[k]
        for k in ("aud", "session", "owner", "gateway", "generation", "workload")
    )
