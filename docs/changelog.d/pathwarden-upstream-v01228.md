Reconcile Pathwarden's classified extension onto upstream v0.12.28
(f1a62fbbdfd2c98cb162582d82c31fe8102acc89), retaining the separately adapted
upstream #1921 guest-refusal repair.

Custom command, capture, recording-retention, verified room/self, streaming speech
and account-choice behavior remains at explicit integration points. Refusal detail
uses upstream JoinResult.reason; the duplicate failureReason port is retired.
Upstream's validated automatic-leave translation replaces the duplicate service
resolver, with camelCase compatibility and the voice assistant's existing default
room-empty window retained. Voice assistants leave on verified room evidence;
stock recording bots keep upstream's configurable silence adapter.

A dead workload preserves its durable reservation until teardown is confirmed,
including upstream's adapter-level dead-start error. Stop attribution and safe
failure details remain covered by the Pathwarden regression cases.

Pathwarden's existing Compose MinIO datastore, volumes and aliases are retained.
This code reconciliation performs no object-store migration or account-session
writeback migration. Fresh upstream Helm storage defaults remain a separate
deployment choice. Flows are opt-in in the fork's Compose configuration.

Unstamped development images can still serve ordinary recording clients; they do
not advertise Pathwarden compatibility. Production builds must carry a full source
revision and a matching, verified image set. Unit/gate success is not a live Meet
admission receipt.
