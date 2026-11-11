# network-session.v1

Private optional network-namespace authority, carried in the existing runtime.v1 env map as
`VEXA_NETWORK_SESSION`. The signed Ed25519 JWT's payload follows `network-session.schema.json`.
`verification.py` is the pure Python boundary verifier shared by the meeting API and runtime;
neither consumer imports the other's implementation. Tokens are never passed to the worker.

One session/owner/gateway/generation/workload binding lasts at most 15 seconds and may be renewed
only while live. A reconnect, different gateway or expired authority cannot silently replace it.
Only the configured Docker runtime advertises `pathwarden-network.v1`. Process/Kubernetes reject
requested personal networking. Public API schemas and the sealed runtime.v1 schema are unchanged.
Slow meeting starts use a private runtime reservation. Meeting API reserves the signed session before
admission or database work, and caller renewals can refresh that reservation before a meeting/session
row exists. Every renewal still carries a valid, at-most-15-second signed lease; no service remints
or lengthens it. The runtime returns an opaque ticket only to Meeting API, seals it to the authenticated
requester and exact meeting-bot workload specification, and resolves the latest unexpired lease when
the workload is created. Changing its caller, profile, environment, workload ID or signed network
binding fails. Tickets and resolved authority are stripped from worker environments and persisted
specifications. Expiry or stop invalidates the ticket; late Docker starts are killed.
The consumed ticket may touch only its exact already-starting/running workload with live authority.
A completed Docker rejection plus a confirmed absent container burns that attempt's ticket but
permits a new ticket for an explicit later attempt under the same unexpired signed session. Timeouts
and uncertain delivery remain fenced; renewing authority never respawns a bot.
