## Shared meeting reliability and authenticated concurrency

- Google Meet admission counts structural participant identities instead of discarding real tiles that contain effects controls.
- Empty-room departure requires injected positive self-only evidence. Unknown observations reset the continuous-alone interval; a hidden self tile cannot prove aloneness.
- `POST /bots` accepts the optional boolean `concurrent_authenticated`. It restores an isolated profile per bot and stamps `userdataReadOnly` in invocation.v1, suppressing shared seed writeback. Existing exclusive-session behavior remains the default.
- Concurrent Google account admission is not established by offline tests. Four concurrent spawn requests are covered with runtime fakes; real account/Meet acceptance remains required.

- acts.v3 adds revisioned applied-state meeting controls and sequence-fenced approved presentation
  show/stop. Paused notes retain ephemeral wake-command recognition but skip collector/live transcript
  and audio retention. Recorder-control failure stays fail-closed; completion markers still finalize.
- Persistent raw/STT debug capture is disabled for voice-enabled bots. Bare wake followed by a command
  remains available while paused. A static branded camera card is optional, off by default.
- Presentation images are pulled only from configured MEETING_SPEECH_URL with scoped capabilities;
  browser-local audience guards, provider presentation-state acknowledgement and refresh revocation
  stop unsafe/stale sharing. Arbitrary screen URLs and writable office sessions are not introduced.
- Full offline bot/join builds/tests,19 authenticated/typed API tests and27 contract golden schemas pass.
  Ten independent review/fix passes ended source-clean; this was not native Bugbot tooling.
- LIVE ACCEPTANCE OPEN: actual Google sharing/camera UI, pause/resume audio,3–4 concurrent signed-in
  admissions and session stability. No running production container/image was changed by this batch.
