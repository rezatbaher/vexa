Meeting startup now rejects a runtime workload returned as `stopped/start_failed`.
The meeting API records its session/workload identity, confirms teardown, persists
`failed/join_failure`, and returns HTTP 502 immediately. An unconfirmed teardown
retains the active reservation and blocks another bot. Runtime health checks
verify that the configured meeting-bot image is present on Docker without pulling
or launching anything; a missing image or failed probe returns HTTP 503. Runtime
logs distinguish a failed start from a spawned workload without exposing configuration.

The API exception ledger no longer waives the four chat, screen and speech-stop
routes already implemented by this fork. Their existing conformance check now
tests them as implemented routes; published schemas and seals are unchanged.

The architecture index now includes the existing acts.v3 contract, and its golden
examples have directory documentation. This records existing implementation;
no action schema or data flow changes.
