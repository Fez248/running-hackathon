/**
 * Rules for running a long dictation session, kept out of the React layer so the
 * awkward parts are unit tested.
 *
 * Chrome's `SpeechRecognition` ends its session on every pause even with
 * `continuous = true`, so an ambient reporter has to restart it constantly. That
 * restart is what makes the feature fragile: an error that recurs immediately
 * (no network on a run, the service refusing) turns a naive
 * `onend -> start()` into a hot loop that burns battery and floods the UI. The
 * helpers below decide which errors are worth another attempt, how long to wait,
 * and when to give up and tell the user.
 */

/** Speech recognition errors we handle by name; anything else is unexpected. */
export type VoiceErrorKind =
  | 'not-allowed'
  | 'service-not-allowed'
  | 'no-speech'
  | 'aborted'
  | 'audio-capture'
  | 'network'
  | 'unknown';

export function voiceErrorKind(error: string): VoiceErrorKind {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
    case 'no-speech':
    case 'aborted':
    case 'audio-capture':
    case 'network':
      return error;
    default:
      return 'unknown';
  }
}

/**
 * Whether the session can continue after an error.
 *
 * A permission refusal and a missing microphone are terminal: the user has to
 * act, and retrying only produces the same failure. `no-speech` and `aborted`
 * are not failures at all — silence is the normal state of a run.
 */
export function isTerminalVoiceError(kind: VoiceErrorKind): boolean {
  return kind === 'not-allowed' || kind === 'service-not-allowed' || kind === 'audio-capture';
}

export const VOICE_ERROR_MESSAGES: Record<VoiceErrorKind, string> = {
  'not-allowed':
    'Microphone access is blocked for this site, so dictation is off. Allow the microphone in your browser’s site settings, then turn dictation back on.',
  'service-not-allowed':
    'The browser refused to use its speech service, so dictation is off. Check the microphone permission for this site.',
  'audio-capture':
    'No microphone was available to record from. Plug one in or pick another input, then turn dictation back on.',
  network:
    'Speech recognition needs a connection and lost it — dictation keeps retrying while you run. Reports can still be typed.',
  'no-speech': 'Still listening — nothing heard yet.',
  aborted: 'Dictation stopped.',
  unknown: 'Speech recognition hit an unexpected error.',
};

/** Restarts that happen this soon after a start are treated as a failed restart. */
export const VOICE_HEALTHY_SESSION_MS = 1_500;
export const VOICE_RESTART_BASE_MS = 500;
export const VOICE_RESTART_MAX_MS = 15_000;
/** After this many consecutive failed restarts the session stops trying. */
export const VOICE_MAX_RESTART_FAILURES = 6;

/**
 * Exponential backoff for restarting the recogniser.
 *
 * A healthy session restarts near-instantly (that is the normal pause-and-resume
 * cycle, and a delay there would swallow the first word of the next sentence);
 * repeated immediate failures back off towards 15s.
 */
export function voiceRestartDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(VOICE_RESTART_MAX_MS, VOICE_RESTART_BASE_MS * 2 ** (consecutiveFailures - 1));
}

export interface VoiceRestartDecision {
  restart: boolean;
  delayMs: number;
  /** Consecutive failures to carry into the next decision. */
  failures: number;
  /** Set when the session is giving up, phrased for the user. */
  message: string | null;
}

/**
 * Decides what to do when a recognition session ends.
 *
 * `sessionMs` is how long the session that just ended actually ran: a session
 * that survived a while was working, so its failure counter resets even if the
 * previous ones failed.
 */
export function decideVoiceRestart(params: {
  wantListening: boolean;
  sessionMs: number;
  consecutiveFailures: number;
}): VoiceRestartDecision {
  const { wantListening, sessionMs, consecutiveFailures } = params;
  if (!wantListening) return { restart: false, delayMs: 0, failures: 0, message: null };

  const healthy = sessionMs >= VOICE_HEALTHY_SESSION_MS;
  const failures = healthy ? 0 : consecutiveFailures + 1;
  if (failures >= VOICE_MAX_RESTART_FAILURES) {
    return {
      restart: false,
      delayMs: 0,
      failures,
      message:
        'Dictation kept dropping out and has been switched off — check the microphone and your connection, then turn it back on. Reports can still be typed.',
    };
  }
  return { restart: true, delayMs: voiceRestartDelayMs(failures), failures, message: null };
}

/**
 * Microphone input level, 0..1, from raw time-domain samples.
 *
 * Root mean square rather than peak: on a run the interesting question is "is my
 * voice getting in over the wind and footfall", which an average answers and a
 * single clipped sample does not.
 */
export function inputLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/** Level bars for the meter: enough resolution to see speech, few enough to read while moving. */
export const VOICE_METER_BARS = 5;

export function meterBars(level: number): number {
  if (level <= 0) return 0;
  // Speech sits low in a linear RMS scale, so the meter is compressed to make
  // normal talking fill the middle of the range instead of the first bar.
  const scaled = Math.sqrt(Math.min(1, level) / 0.35);
  return Math.max(1, Math.min(VOICE_METER_BARS, Math.round(scaled * VOICE_METER_BARS)));
}
