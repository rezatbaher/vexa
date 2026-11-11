- Google Meet guest joins detect permission refusal before or after the join click and retry
  at most three times within the issued budget. Refused pages are never reported as an
  admission wait. Cancellation stops further attempts before browser teardown completes.
- Adapted from upstream Vexa-ai/vexa#1921 (31122f96), retaining Pathwarden microphone,
  room-observation, recording and custom-control behavior. Typed refusal detail uses
  the existing lifecycle reason field and the permanent rejection completion enum.
- Offline join/driver regressions and a real browser fixture are development evidence;
  successful admission on the production egress address remains a required live check.
- List/status projections expose only a derived typed refusal code; full exception
  diagnostics and logs stay excluded. A consumer/provider regression exercises
  GET /bots through Pathwarden's actual status and outcome boundary.
