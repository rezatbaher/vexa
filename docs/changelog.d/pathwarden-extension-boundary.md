Pathwarden meeting commands and room observations now connect through one typed,
in-process bot extension factory. The meeting-api registers its custom router at
one seam and exposes authenticated build capabilities through the gateway.

The image build stamps the immutable source revision and derives expected bot
commands from the wired extension registry. An absent, disabled or unstamped
extension does not advertise compatibility. Capabilities describe build support;
per-bot configuration and applied mute/notes/presentation state still require
the existing bot observations. Existing acts.v3 and /speak clients remain supported.

No storage, schema, account profile or session writeback behavior changes here.
