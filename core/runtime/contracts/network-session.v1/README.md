# network-session.v1

Private optional network-namespace authority, carried in the existing runtime.v1 env map as
`VEXA_NETWORK_SESSION`. The signed Ed25519 JWT's payload follows `network-session.schema.json`.
`verification.py` is the pure Python boundary verifier shared by the meeting API and runtime;
neither consumer imports the other's implementation. Tokens are never passed to the worker.

One session/owner/gateway/generation/workload binding lasts at most 15 seconds and may be renewed
only while live. A reconnect, different gateway or expired authority cannot silently replace it.
Only the configured Docker runtime advertises `pathwarden-network.v1`. Process/Kubernetes reject
requested personal networking. Public API schemas and the sealed runtime.v1 schema are unchanged.
