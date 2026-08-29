import { describe, expect, it } from 'vitest';
import {
  VOICE_MAX_RESTART_FAILURES,
  VOICE_RESTART_MAX_MS,
  decideVoiceRestart,
  inputLevel,
  isTerminalVoiceError,
  meterBars,
  voiceErrorKind,
  voiceRestartDelayMs,
} from './voice-capture';

describe('voiceErrorKind', () => {
  it('keeps the errors we act on and buckets the rest', () => {
    expect(voiceErrorKind('not-allowed')).toBe('not-allowed');
    expect(voiceErrorKind('network')).toBe('network');
    expect(voiceErrorKind('language-not-supported')).toBe('unknown');
  });
});

describe('isTerminalVoiceError', () => {
  it('gives up only where retrying cannot help', () => {
    expect(isTerminalVoiceError('not-allowed')).toBe(true);
    expect(isTerminalVoiceError('service-not-allowed')).toBe(true);
    expect(isTerminalVoiceError('audio-capture')).toBe(true);
    expect(isTerminalVoiceError('network')).toBe(false);
    expect(isTerminalVoiceError('no-speech')).toBe(false);
    expect(isTerminalVoiceError('aborted')).toBe(false);
  });
});

describe('voiceRestartDelayMs', () => {
  it('restarts a working session immediately', () => {
    expect(voiceRestartDelayMs(0)).toBe(0);
  });

  it('backs off exponentially and caps', () => {
    expect(voiceRestartDelayMs(1)).toBe(500);
    expect(voiceRestartDelayMs(2)).toBe(1_000);
    expect(voiceRestartDelayMs(3)).toBe(2_000);
    expect(voiceRestartDelayMs(99)).toBe(VOICE_RESTART_MAX_MS);
  });
});

describe('decideVoiceRestart', () => {
  it('does not restart once the user has stopped', () => {
    expect(
      decideVoiceRestart({ wantListening: false, sessionMs: 10, consecutiveFailures: 3 }),
    ).toEqual({ restart: false, delayMs: 0, failures: 0, message: null });
  });

  it('resumes a healthy session with no delay and forgets past failures', () => {
    const decision = decideVoiceRestart({
      wantListening: true,
      sessionMs: 30_000,
      consecutiveFailures: 4,
    });
    expect(decision).toEqual({ restart: true, delayMs: 0, failures: 0, message: null });
  });

  it('backs off when sessions die immediately', () => {
    const first = decideVoiceRestart({
      wantListening: true,
      sessionMs: 20,
      consecutiveFailures: 0,
    });
    expect(first.restart).toBe(true);
    expect(first.failures).toBe(1);
    expect(first.delayMs).toBe(500);

    const second = decideVoiceRestart({
      wantListening: true,
      sessionMs: 20,
      consecutiveFailures: first.failures,
    });
    expect(second.delayMs).toBe(1_000);
  });

  it('stops and explains itself after too many failed restarts', () => {
    const decision = decideVoiceRestart({
      wantListening: true,
      sessionMs: 20,
      consecutiveFailures: VOICE_MAX_RESTART_FAILURES - 1,
    });
    expect(decision.restart).toBe(false);
    expect(decision.message).toMatch(/typed/);
  });
});

describe('inputLevel', () => {
  it('is zero for silence and for no samples', () => {
    expect(inputLevel(new Float32Array(0))).toBe(0);
    expect(inputLevel(new Float32Array([0, 0, 0, 0]))).toBe(0);
  });

  it('is the root mean square of the samples', () => {
    expect(inputLevel(new Float32Array([1, -1, 1, -1]))).toBeCloseTo(1);
    expect(inputLevel(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
  });
});

describe('meterBars', () => {
  it('shows nothing for silence and something for any real signal', () => {
    expect(meterBars(0)).toBe(0);
    expect(meterBars(0.001)).toBe(1);
  });

  it('fills the middle of the meter at conversational level and never overflows', () => {
    expect(meterBars(0.1)).toBeGreaterThanOrEqual(2);
    expect(meterBars(0.1)).toBeLessThanOrEqual(4);
    expect(meterBars(1)).toBe(5);
  });
});
