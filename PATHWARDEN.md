# Vexa + Pathwarden

## Deploy (Compose — multi-meeting)

```bash
cd /home/pathwarden/HELPERS/vexa
# .env already under deploy/compose/
make all
docker pull vexaai/vexa-bot:v012   # if BROWSER_IMAGE warns
# attach to Pathwarden network (gateway reachability from backend)
for c in vexa-v012-gateway-1 vexa-v012-meeting-api-1 vexa-v012-runtime-1 vexa-v012-admin-api-1; do
  docker network connect pathwarden_network "$c" 2>/dev/null || true
done
```

Gateway: `http://127.0.0.1:18056` (host) / `http://vexa-v012-gateway-1:8000` (from Pathwarden backend).

Secrets (chmod 600): `.deploy-secrets.env` — `ADMIN_TOKEN`, `VEXA_API_KEY`, …

Pathwarden `.env`: `VEXA_ENABLED=true`, `VEXA_API_BASE=http://vexa-v012-gateway-1:8000`, `VEXA_API_KEY=…`.

## Smoke (2026-07-20)

- Single Meet synthetic `aaa-bbbb-ccc`: `POST /bots` → container `vexa-mtg-*` with image `vexaai/vexa-bot:v012`.
- Parallel: two Meets → two containers concurrently (`PARALLEL_SMOKE_OK`).
- Note: `DELETE /bots/...` may return HTTP 500 (upstream redis client recursion) while still setting
  `stop_requested`; Pathwarden's `stop()` treats that as success when status clears. Force-clean leftover:
  `docker rm -f $(docker ps -aq --filter name=vexa-mtg)`.

## STT / Pathwarden Whisper

**Updated 2026-07-21: Vexa now transcribes live.** `TRANSCRIBE_ENABLED=true` +
`TRANSCRIPTION_SERVICE_URL=https://stt.pathwarden.com/batch` (+ `TRANSCRIPTION_MODEL=large-v3-turbo`,
`TRANSCRIPTION_SERVICE_TOKEN=` left blank — that endpoint doesn't enforce a bearer token) in compose
`.env`, reusing the SAME whisper-batch endpoint the Pathwarden backend already points
`WHISPER_BATCH_URL`/`WHISPER_BATCH_MODEL` at (identical OpenAI-compatible `/v1/audio/transcriptions`
contract — no separate `deploy/transcription` GPU/CPU unit needed). Applied via
`docker compose -p vexa-v012 -f docker-compose.yml up -d meeting-api terminal` (recreates only the
services that read these vars — `runtime`/`agent-api` also got recreated as compose dependents;
postgres/redis/minio/gateway/admin-api/mcp were untouched, **no volumes touched, no `make down`**).
Verified: all 4 recreated containers came back healthy, `meeting-api` shows the new env values, and
`python3 -c "urllib.request.urlopen('https://stt.pathwarden.com/batch/health')"` from inside
`vexa-v012-meeting-api-1` returned `200`. **Not yet verified**: an actual end-to-end bot → this
service → `transcript.v1` segments → `GET /transcripts/...` round trip (needs a real or synthetic
Meet with speech).

**Why this matters (root cause of a 2026-07-21 prod incident):** with STT off, EVERY Vexa meeting
depended entirely on Pathwarden re-transcribing the whole downloaded recording in one shot after the
call ended — a single request against a whole (possibly multi-hour) file, which can time out, and
which the Pathwarden agent tried to "fix" by hand-converting the recording's format when that failed
(see CLAUDE.md → "Vexa transcription hardening", 2026-07-21). With STT on, Vexa transcribes in small
rolling windows DURING the call (`core/meetings/services/transcription`, `modules/whisper`,
`modules/gmeet-pipeline` — real per-channel Google Meet speaker identity, "identity carried, never
derived"), so Pathwarden's `meeting_bot_lifecycle.ingest()` gets a real `transcript_text` and
`_finalize_ingest_and_transcribe` skips the download-and-re-transcribe path entirely
(`meeting_merge_service.finalize_from_transcript_text`) — no more single point of failure on a big
post-hoc file. Pathwarden's own `transcribe_and_summarize_audio` (`WHISPER_BATCH_URL`,
`VEXA_AUTO_TRANSCRIBE=true`) is now only the FALLBACK for a meeting Vexa didn't transcribe (e.g. this
setting reverted, or the meeting had no detected speech).

## Voice agent — speak/chat/screen INTO the meeting (2026-07-23 Pathwarden patch)

The upstream open-core build declares `POST /bots/{platform}/{native}/speak|/chat|/screen` in the
gateway (api.v1) but **never mounted the meeting-api handlers**, so they 404'd. Pathwarden added
**`core/meetings/services/meeting-api/src/meeting_api/lifecycle/voice_router.py`** (mounted in
`app.py` right after the stop router) which mirrors the `leave` publisher exactly: it resolves the
caller's ACTIVE meeting (`repo.find_active`) and PUBLISHES the corresponding `acts.v1` command to
`bot_commands:meeting:{id}` via the same injected `CommandPublisher`.

- **speak / speak_stop** — the bot ALREADY handles these (`src/index.ts` voiceHandler +
  `tts-playback.ts`). Speech is synthesized by the bot at **`${TTS_SERVICE_URL}/v1/audio/speech`**
  (OpenAI-compatible, PCM). **To speak in Pathwarden's own Kokoro voice, set the Vexa bot env
  `TTS_SERVICE_URL` to Pathwarden's `KOKORO_TTS_URL` (+ `TTS_API_TOKEN` = `KOKORO_TTS_API_KEY`).**
  The Pathwarden tool passes the configured Kokoro `voice` in the act, so no base64 is needed.
- **chat_send / screen_show / screen_stop** — the command is published, but the bot's DOM handler
  for these is still "out of scope" in `voiceHandler` (a follow-up); the act is currently ignored by
  the bot, so these no-op until the bot handler lands.

**Deploy:** rebuild the meeting-api image and set the bot's `TTS_SERVICE_URL` (Kokoro). On the
Pathwarden side set `VEXA_VOICE_AGENT_ENABLED=true` so bots join with `voice_agent_enabled=true`.
Live-verify with a real Meet + a set of ears (the agent's `vexa_say_in_meeting` tool).
