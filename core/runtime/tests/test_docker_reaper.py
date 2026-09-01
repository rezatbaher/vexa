"""Guard the exited-container reaper (``DockerBackend.reap_exited_workloads``).

WHY IT EXISTS: nothing in this runtime ever removed a finished workload container. ``auto_remove`` is
set nowhere, the kernel only OBSERVES an exit, and the single ``docker rm`` path
(``DELETE /workloads/{id}`` → ``Runtime.destroy``) is driven by meeting-api sweeps that query only
NON-TERMINAL meetings — so a meeting bot that completes normally makes its meeting terminal BEFORE
any teardown is issued and its container is never removed by anyone. Production accumulated 17 husks
over six weeks (5 on dev) before a human deleted them by hand.

The parser tests need no daemon. The behavioural tests drive the REAL docker substrate (same idiom as
test_docker_backend.py) because the three properties that matter — it removes an exited container, it
NEVER touches a running one, and it is scoped to this stack's network — are all properties of the
daemon's own filtering, which a mock would merely restate.
"""
import json
import shutil
import subprocess
import uuid

import pytest

from runtime_kernel.docker_backend import DockerBackend


# ── _finished_at: the fiddly half, no daemon needed ──────────────────────────────────────────────

class _Resp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


def _backend_returning(payload, status=200):
    b = DockerBackend()
    b._req = lambda method, path, **kw: _Resp(status, payload)  # type: ignore[assignment]
    return b


def test_finished_at_parses_docker_nanosecond_rfc3339():
    """Docker emits 9 fractional digits; datetime.fromisoformat accepts at most 6. Getting this
    wrong makes EVERY finish time unreadable, which (by the skip-on-None rule) silently disables the
    reaper rather than failing loudly."""
    b = _backend_returning({"State": {"Running": False, "FinishedAt": "2026-07-23T11:26:59.997971123Z"}})
    dt = b._finished_at("cid")
    assert dt is not None
    assert (dt.year, dt.month, dt.day, dt.hour, dt.minute) == (2026, 7, 23, 11, 26)
    assert dt.tzinfo is not None, "must be timezone-aware or the age subtraction raises"


def test_finished_at_ignores_dockers_zero_value():
    """`0001-01-01T00:00:00Z` means "never finished". Treating it as a real timestamp would make it
    ~2000 years old — i.e. instantly reapable — which is the worst possible misread."""
    b = _backend_returning({"State": {"Running": False, "FinishedAt": "0001-01-01T00:00:00Z"}})
    assert b._finished_at("cid") is None


def test_finished_at_is_none_for_a_running_container():
    b = _backend_returning({"State": {"Running": True, "FinishedAt": "2026-07-23T11:26:59.9Z"}})
    assert b._finished_at("cid") is None


def test_finished_at_is_none_when_inspect_fails():
    b = _backend_returning({}, status=404)
    assert b._finished_at("cid") is None


def test_reap_is_disabled_by_a_non_positive_window():
    """`RUNTIME_REAP_EXITED_AFTER_SEC=0` is the documented off switch — it must not even list."""
    b = DockerBackend()

    def _boom(*a, **kw):
        raise AssertionError("reap must issue no docker call when disabled")

    b._req = _boom  # type: ignore[assignment]
    assert b.reap_exited_workloads(older_than_sec=0) == 0
    assert b.reap_exited_workloads(older_than_sec=-1) == 0


def test_reap_never_raises_out(monkeypatch):
    """Housekeeping must never disturb the runtime: a docker outage is a warning, not an exception."""
    b = DockerBackend()

    def _boom(*a, **kw):
        raise RuntimeError("docker is down")

    b._req = _boom  # type: ignore[assignment]
    assert b.reap_exited_workloads(older_than_sec=1) == 0


# ── behaviour against the real substrate ─────────────────────────────────────────────────────────

def _docker_ok() -> bool:
    return bool(shutil.which("docker")) and subprocess.run(
        ["docker", "info"], capture_output=True
    ).returncode == 0


def _sh(*args) -> str:
    return subprocess.run(args, capture_output=True, text=True).stdout.strip()


def _exists(name: str) -> bool:
    return name in _sh("docker", "ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.Names}}").split()


@pytest.mark.skipif(not _docker_ok(), reason="docker daemon not available")
def test_reaper_removes_exited_spares_running_and_stays_in_its_own_stack(monkeypatch):
    tag = uuid.uuid4().hex[:8]
    net = f"reaptest-{tag}"
    dead, live, other = f"reaptest-dead-{tag}", f"reaptest-live-{tag}", f"reaptest-other-{tag}"
    # `other` is managed + exited but on the DEFAULT network: it stands in for another vexa stack's
    # container on a shared daemon. The managed label is identical across stacks, so the network is
    # the only thing stopping one stack's janitor from reaping another's.
    try:
        _sh("docker", "network", "create", net)
        _sh("docker", "run", "-d", "--name", dead, "--network", net,
            "--label", "runtime.managed=true", "--label", f"runtime.workload_id=mtg-{tag}-dead",
            "alpine:latest", "sh", "-c", "exit 0")
        _sh("docker", "run", "-d", "--name", live, "--network", net,
            "--label", "runtime.managed=true", "--label", f"runtime.workload_id=mtg-{tag}-live",
            "alpine:latest", "sleep", "600")
        _sh("docker", "run", "-d", "--name", other,
            "--label", "runtime.managed=true", "--label", f"runtime.workload_id=mtg-{tag}-other",
            "alpine:latest", "sh", "-c", "exit 0")
        subprocess.run(["docker", "wait", dead], capture_output=True)
        subprocess.run(["docker", "wait", other], capture_output=True)

        monkeypatch.setenv("DOCKER_NETWORK", net)
        b = DockerBackend()

        # Retention holds: nothing here is a day old.
        assert b.reap_exited_workloads(older_than_sec=86_400) == 0
        assert _exists(dead), "a young corpse must be kept for post-mortem"

        removed = b.reap_exited_workloads(older_than_sec=0.001)
        assert removed == 1, f"expected exactly the exited in-stack container, removed {removed}"
        assert not _exists(dead)
        assert _exists(live), "a RUNNING container must never be reaped — that is a live meeting"
        assert _exists(other), "another stack's container must never be reaped"
    finally:
        for n in (dead, live, other):
            subprocess.run(["docker", "rm", "-f", n], capture_output=True)
        subprocess.run(["docker", "network", "rm", net], capture_output=True)
