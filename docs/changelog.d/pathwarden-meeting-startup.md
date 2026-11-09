Meeting startup now rejects a runtime workload returned as `stopped/start_failed`.
The meeting API records its session/workload identity, confirms teardown, persists
`failed/join_failure`, and returns HTTP 502 immediately. An unconfirmed teardown
retains the active reservation and blocks another bot. Runtime health checks
verify that the configured meeting-bot image is present on Docker without pulling
or launching anything; a missing image or failed probe returns HTTP 503. Runtime
logs distinguish a failed start from a spawned workload without exposing configuration.
