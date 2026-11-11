"""Private optional caller-owned networking; every crossing uses network-session.v1."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

from fastapi import HTTPException


def _contract():
    for root in Path(__file__).resolve().parents:
        for relative in (
            "runtime/contracts/network-session.v1/verification.py",
            "contracts/network-session.v1/verification.py",
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


async def capability(runtime):
    if os.getenv("VEXA_NETWORK_SESSION_ENABLED", "false").lower() != "true":
        return None
    try:
        contract.public_key(os.getenv(contract.PUBLIC_KEY_ENV, ""))
        probe = getattr(runtime, "network_capability", None)
        return (
            contract.PROTOCOL if probe and await probe() == contract.PROTOCOL else None
        )
    except Exception:
        return None


async def authorize(token, runtime, platform, native_meeting_id):
    if await capability(runtime) != contract.PROTOCOL:
        raise HTTPException(
            status_code=503,
            detail="This deployment does not support personal network sessions",
        )
    try:
        return contract.verify(
            token,
            os.environ[contract.PUBLIC_KEY_ENV],
            expected_workload={
                "platform": platform,
                "native_meeting_id": native_meeting_id,
            },
        )
    except ValueError:
        raise HTTPException(
            status_code=403, detail="Personal network authority is invalid or expired"
        ) from None


def binding(claims):
    return {key: claims[key] for key in ("session", "owner", "generation", "gateway")}


async def renew(repo, runtime, *, user_id, platform, native_meeting_id, token):
    claims = await authorize(token, runtime, platform, native_meeting_id)
    row = await repo.find_active(user_id, platform, native_meeting_id)
    refresh_reservation = getattr(runtime, "reserve_network", None)
    if not row:
        if not refresh_reservation:
            raise HTTPException(
                status_code=404, detail="Meeting network session is not active"
            )
        try:
            return await refresh_reservation(token, str(user_id), create=False)
        except Exception:
            raise HTTPException(
                status_code=404, detail="Meeting network reservation is not active"
            ) from None
    if (row.get("data") or {}).get("network_session") != binding(claims):
        raise HTTPException(
            status_code=409, detail="Meeting network affinity differs from this session"
        )
    if refresh_reservation:
        try:
            return await refresh_reservation(token, str(user_id), create=False)
        except Exception:
            raise HTTPException(
                status_code=503, detail="Meeting network renewal is unavailable"
            ) from None
    workload_id = row.get("bot_container_id")
    if not workload_id:
        sessions = await repo.list_sessions(meeting_id=row["id"])
        if sessions:
            workload_id = f"mtg-{row['id']}-{str(sessions[-1])[:8]}"
    if not workload_id:
        raise HTTPException(
            status_code=404, detail="Meeting workload is not registered yet"
        )
    refresh = getattr(runtime, "renew_network", None)
    if not refresh:
        raise HTTPException(
            status_code=503, detail="Runtime network renewal is unsupported"
        )
    try:
        return await refresh(workload_id, token)
    except Exception:
        raise HTTPException(
            status_code=503, detail="Meeting network renewal is unavailable"
        ) from None
