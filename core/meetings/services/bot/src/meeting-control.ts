/** Applied meeting controls. Paused speech is ephemeral and never reaches transcript storage. */
import type { Act, TranscriptSegment } from './contracts.js';
import type { TranscriptSink } from './ports.js';

export interface ControlState {
  revision: number; notes_enabled: boolean; replies_muted: boolean;
  recording_enabled: boolean | null; transcription_enabled: boolean;
}
export function createMeetingControl(opts: {
  transcript: TranscriptSink;
  publish(frame: Record<string, unknown>): Promise<unknown>;
  recordingConfigured: boolean; transcriptionConfigured: boolean;
  setRecordingPaused(paused: boolean): Promise<boolean>;
  stopSpeaking(): Promise<void>;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  let state: ControlState = { revision: 0, notes_enabled: true, replies_muted: false,
    recording_enabled: opts.recordingConfigured ? null : false, transcription_enabled: opts.transcriptionConfigured };
  let retainAfter = 0;
  let recorderUnsafe = false;
  let chain = Promise.resolve();
  // Keep these wire aliases aligned with Pathwarden organization_meeting_policy.WAKE_ALIASES.
  const aliases = ['hey meeting assistant', 'hey assistant', 'hey agent', 'hey agents', 'hey gente',
    'hey gents', 'hey gent', 'hey vox ai', 'vox ai', 'hey voxi', 'voxi', 'hey wokes ai',
    'hey woks ai', 'hey vokes ai', 'hey box ai', 'hey pathwarden', 'ok agent', 'okay agent',
    'hei vox ai', 'هی وکسای', 'وکسای'];
  const wake = new RegExp('^\\s*(?:' + aliases.sort((a, b) => b.length - a.length)
    .map(a => a.split(' ').join('[\\s,.-]*')).join('|') + ')(?=[\\s,.!?؟:-]|$)[\\s,:.!?؟—-]*', 'iu');
  const command = /^(?:please\s+)?(?:next|previous|resume|start|enable|pause|stop|disable|mute|unmute|leave|what(?:'s| is)|status|are you|tell me)\b/i;
  const calls = new Map<string, { after: number; until: number }>();
  const sink: TranscriptSink = { async publish(segment: TranscriptSegment) {
    const start = segment.absolute_start_time ? Date.parse(segment.absolute_start_time) : segment.start * 1000;
    if (state.notes_enabled && start >= retainAfter) {
      await opts.transcript.publish(segment);
      return;
    }
    if (state.notes_enabled || !segment.completed) return;
    const match = wake.exec(segment.text);
    const text = match ? segment.text.slice(match[0].length).trim() : segment.text.trim();
    const previous = calls.get(segment.speaker);
    if (match && !text) {
      calls.set(segment.speaker, { after: segment.end * 1000 - 500, until: segment.end * 1000 + 12000 });
      if (calls.size > 64) calls.delete(calls.keys().next().value!);
    }
    const continuation = previous && start >= previous.after && start <= previous.until;
    if ((match && (!text || command.test(text))) || (continuation && command.test(text))) {
      if (text) calls.delete(segment.speaker);
      await opts.publish({ type: 'meeting.command.v1', segment });
    }
  }};
  const handle = (act: Act): Promise<void> => {
    if (act.action !== 'meeting_control') return Promise.resolve();
    const apply = async () => {
      let error: string | undefined;
      if (act.revision > state.revision) {
        if (typeof act.notes_enabled === 'boolean') {
          // Gate retention BEFORE awaiting browser work; crossing utterances are never saved.
          state = { ...state, notes_enabled: false, transcription_enabled: false };
          retainAfter = now();
          try {
            if (recorderUnsafe) throw new Error('recorder_requires_restart');
            const applied = await opts.setRecordingPaused(!act.notes_enabled);
            if (!applied) throw new Error('recorder_state_unknown');
            state = { ...state, notes_enabled: act.notes_enabled,
              recording_enabled: opts.recordingConfigured && act.notes_enabled,
              transcription_enabled: opts.transcriptionConfigured && act.notes_enabled };
            retainAfter = now();
          } catch {
            recorderUnsafe = true;
            error = 'recording_control_failed';
            state = { ...state, recording_enabled: null };
          }
        }
        if (typeof act.replies_muted === 'boolean') {
          state = { ...state, replies_muted: act.replies_muted };
          if (act.replies_muted) await opts.stopSpeaking();
        }
        if (act.notes_enabled === undefined && !recorderUnsafe) {
          try {
            const applied = await opts.setRecordingPaused(!state.notes_enabled);
            state = { ...state, recording_enabled: applied ? opts.recordingConfigured && state.notes_enabled : null };
          } catch { state = { ...state, recording_enabled: null }; }
        }
        state = { ...state, revision: act.revision };
      }
      await opts.publish({ type: 'meeting.control.v1', request_id: act.request_id,
        observed_at: new Date(now()).toISOString(), state, ...(error ? { error } : {}) });
    };
    chain = chain.then(apply);
    // Keep future commands usable after a transport failure; this command still reports failure.
    const result = chain;
    chain = chain.catch(() => {});
    return result;
  };
  return { sink, handle, retain: () => state.notes_enabled, muted: () => state.replies_muted };
}
