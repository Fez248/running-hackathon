import { describe, expect, it } from 'vitest';
import {
  CONSENT_RETRY_COOLDOWN_MS,
  canRequestLocation,
  geolocationFailure,
  initialLocationConsent,
  parseLocationConsent,
  reduceLocationConsent,
  requestCooldownRemainingMs,
  retryCooldownMs,
} from './location-consent';

describe('canRequestLocation', () => {
  it('allows a first request', () => {
    expect(canRequestLocation(initialLocationConsent(), 1_000)).toBe(true);
  });

  it('never re-prompts after a denial', () => {
    const denied = reduceLocationConsent(initialLocationConsent(), {
      type: 'failed',
      failure: 'denied',
    });
    expect(denied.state).toBe('denied');
    expect(canRequestLocation(denied, 1_000)).toBe(false);
    expect(canRequestLocation(denied, 1_000 + 24 * 3_600_000)).toBe(false);
    expect(requestCooldownRemainingMs(denied, 1_000)).toBe(Number.POSITIVE_INFINITY);
  });

  it('re-prompts after a denial only once the browser reports the block is gone', () => {
    const denied = reduceLocationConsent(initialLocationConsent(), {
      type: 'failed',
      failure: 'denied',
    });
    const reset = reduceLocationConsent(denied, { type: 'observed', state: 'prompt' });
    expect(canRequestLocation(reset, 2_000)).toBe(true);
  });

  it('backs off retryable failures instead of blocking them', () => {
    let record = reduceLocationConsent(initialLocationConsent(), { type: 'requested', at: 0 });
    record = reduceLocationConsent(record, { type: 'failed', failure: 'timeout' });
    expect(canRequestLocation(record, CONSENT_RETRY_COOLDOWN_MS - 1)).toBe(false);
    expect(canRequestLocation(record, CONSENT_RETRY_COOLDOWN_MS)).toBe(true);

    record = reduceLocationConsent(record, { type: 'requested', at: CONSENT_RETRY_COOLDOWN_MS });
    record = reduceLocationConsent(record, { type: 'failed', failure: 'position-unavailable' });
    expect(record.failedAttempts).toBe(2);
    expect(retryCooldownMs(record.failedAttempts)).toBe(CONSENT_RETRY_COOLDOWN_MS * 2);
  });

  it('caps the backoff', () => {
    expect(retryCooldownMs(100)).toBe(60_000);
  });

  it('clears the backoff once a fix arrives', () => {
    let record = reduceLocationConsent(initialLocationConsent(), { type: 'requested', at: 0 });
    record = reduceLocationConsent(record, { type: 'failed', failure: 'timeout' });
    record = reduceLocationConsent(record, { type: 'granted' });
    expect(record).toMatchObject({ state: 'granted', failedAttempts: 0, lastFailure: null });
    expect(canRequestLocation(record, 1)).toBe(true);
  });

  it('treats a missing Geolocation API as terminal', () => {
    const record = reduceLocationConsent(initialLocationConsent(), {
      type: 'failed',
      failure: 'unavailable',
    });
    expect(record.state).toBe('unavailable');
    expect(canRequestLocation(record, 10 ** 12)).toBe(false);
  });
});

describe('parseLocationConsent', () => {
  it('round-trips a stored record', () => {
    const record = reduceLocationConsent(
      reduceLocationConsent(initialLocationConsent(), { type: 'requested', at: 42 }),
      { type: 'failed', failure: 'timeout' },
    );
    expect(parseLocationConsent(JSON.stringify(record))).toEqual(record);
  });

  it('degrades unusable values to a fresh record', () => {
    expect(parseLocationConsent(null)).toEqual(initialLocationConsent());
    expect(parseLocationConsent('not json')).toEqual(initialLocationConsent());
    expect(parseLocationConsent('[]')).toEqual(initialLocationConsent());
    expect(parseLocationConsent('{"state":"nonsense","failedAttempts":-3}')).toEqual(
      initialLocationConsent(),
    );
  });
});

describe('geolocationFailure', () => {
  it('maps the three GeolocationPositionError codes', () => {
    expect(geolocationFailure(1)).toBe('denied');
    expect(geolocationFailure(2)).toBe('position-unavailable');
    expect(geolocationFailure(3)).toBe('timeout');
    expect(geolocationFailure(99)).toBe('position-unavailable');
  });
});

describe('observed states', () => {
  it('ignores an unknown observation rather than losing what we know', () => {
    const granted = reduceLocationConsent(initialLocationConsent(), { type: 'granted' });
    expect(reduceLocationConsent(granted, { type: 'observed', state: 'unknown' })).toEqual(granted);
  });

  it('follows a revocation made in browser settings', () => {
    const granted = reduceLocationConsent(initialLocationConsent(), { type: 'granted' });
    expect(reduceLocationConsent(granted, { type: 'observed', state: 'denied' }).state).toBe(
      'denied',
    );
  });
});

describe('retry-allowed', () => {
  it('re-opens a denial that no Permissions API can confirm is still in force', () => {
    let record = reduceLocationConsent(initialLocationConsent(), { type: 'requested', at: 1_000 });
    record = reduceLocationConsent(record, { type: 'failed', failure: 'denied' });
    expect(canRequestLocation(record, 2_000)).toBe(false);

    const reopened = reduceLocationConsent(record, { type: 'retry-allowed' });
    expect(reopened.state).toBe('prompt');
    expect(reopened.lastFailure).toBeNull();
    expect(canRequestLocation(reopened, 2_000)).toBe(true);
  });

  it('lands back on denied when the browser is still blocking', () => {
    const reopened = reduceLocationConsent(
      reduceLocationConsent(initialLocationConsent(), { type: 'failed', failure: 'denied' }),
      { type: 'retry-allowed' },
    );
    const reDenied = reduceLocationConsent(reopened, { type: 'failed', failure: 'denied' });
    expect(reDenied.state).toBe('denied');
    expect(canRequestLocation(reDenied, 5_000)).toBe(false);
  });

  it('leaves states the user cannot fix in settings alone', () => {
    const unavailable = reduceLocationConsent(initialLocationConsent(), {
      type: 'failed',
      failure: 'unavailable',
    });
    expect(reduceLocationConsent(unavailable, { type: 'retry-allowed' })).toEqual(unavailable);

    const granted = reduceLocationConsent(initialLocationConsent(), { type: 'granted' });
    expect(reduceLocationConsent(granted, { type: 'retry-allowed' })).toEqual(granted);
  });
});
