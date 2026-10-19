# acts.v2 — bounded meeting delivery

Retains every v1 command and adds `speak_stream` and `chat_stream`. Both carry a UUID
`speech_id` and a short-lived, audience/generation-bound `stream_token`. No arbitrary URL is
accepted: the bot pulls from its infrastructure-owned `MEETING_SPEECH_URL`.

The capability is secret. Never log the act body or bearer header. Speech and text each have a
single-use server claim. HTTP acceptance means queued; playback callbacks and DOM submission
have separate reported states. A cancelled request or changed room cannot restart on late bytes.

v1 remains sealed and byte-identical. Older bots ignore unknown v2 actions; enable the integration
only after the new bot, meeting-api and runtime are verified together.
