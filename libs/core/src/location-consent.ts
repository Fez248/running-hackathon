/**
 * Location consent state, kept out of the React layer so it can be unit tested
 * and reused by any surface that needs GPS.
 *
 * The browser only shows its location prompt once per origin: after a denial
 * Chrome resolves `getCurrentPosition` straight to `PERMISSION_DENIED` without
 * asking the user again, so an app that keeps calling it produces an error loop
 * and no way forward. The rules below decide when asking is worthwhile at all,
 * which is what lets the UI switch to browser-settings instructions instead.
 *
 * Nothing here stores a coordinate: consent bookkeeping is an outcome, a
 * timestamp and a counter.
 */

export const LOCATION_PERMISSION_STATES = [
  'unknown',
  'prompt',
  'granted',
  'denied',
  'unavailable',
] as const;

export type LocationPermissionState = (typeof LOCATION_PERMISSION_STATES)[number];

/** Why the last attempt to obtain a fix failed, if it did. */
export type LocationConsentFailure = 'denied' | 'position-unavailable' | 'timeout' | 'unavailable';

export interface LocationConsentRecord {
  state: LocationPermissionState;
  /** Epoch millis of the last time the browser prompt was raised. */
  lastRequestedAt: number | null;
  /**
   * Consecutive failures that were *not* a denial (no signal, timeout). These
   * are retryable, but not instantly: a phone indoors would otherwise be asked
   * on every render.
   */
  failedAttempts: number;
  lastFailure: LocationConsentFailure | null;
}

/** Backoff after a retryable failure, capped so a run is never blocked for long. */
export const CONSENT_RETRY_COOLDOWN_MS = 15_000;
export const CONSENT_MAX_RETRY_COOLDOWN_MS = 60_000;

export function initialLocationConsent(): LocationConsentRecord {
  return { state: 'unknown', lastRequestedAt: null, failedAttempts: 0, lastFailure: null };
}

/**
 * Reads a persisted record. Anything unrecognised degrades to a fresh record
 * rather than throwing — a stale or hand-edited localStorage value must not
 * break the map.
 */
export function parseLocationConsent(raw: string | null | undefined): LocationConsentRecord {
  if (!raw) return initialLocationConsent();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return initialLocationConsent();
  }
  if (typeof value !== 'object' || value === null) return initialLocationConsent();
  const candidate = value as Record<string, unknown>;
  const state = LOCATION_PERMISSION_STATES.find((s) => s === candidate.state) ?? 'unknown';
  const lastRequestedAt =
    typeof candidate.lastRequestedAt === 'number' && Number.isFinite(candidate.lastRequestedAt)
      ? candidate.lastRequestedAt
      : null;
  const failedAttempts =
    typeof candidate.failedAttempts === 'number' && Number.isFinite(candidate.failedAttempts)
      ? Math.max(0, Math.floor(candidate.failedAttempts))
      : 0;
  const lastFailure = (
    ['denied', 'position-unavailable', 'timeout', 'unavailable'] as LocationConsentFailure[]
  ).find((f) => f === candidate.lastFailure) ?? null;
  return { state, lastRequestedAt, failedAttempts, lastFailure };
}

export function retryCooldownMs(failedAttempts: number): number {
  if (failedAttempts <= 0) return 0;
  return Math.min(CONSENT_MAX_RETRY_COOLDOWN_MS, CONSENT_RETRY_COOLDOWN_MS * failedAttempts);
}

/**
 * Whether raising the browser prompt can still achieve anything.
 *
 * `denied` and `unavailable` are terminal for this origin: only the user, in
 * browser settings, can undo them, so the UI must explain that instead of
 * calling the API again.
 */
export function canRequestLocation(record: LocationConsentRecord, now: number): boolean {
  if (record.state === 'denied' || record.state === 'unavailable') return false;
  if (record.state === 'granted') return true;
  if (record.failedAttempts === 0 || record.lastRequestedAt == null) return true;
  return now - record.lastRequestedAt >= retryCooldownMs(record.failedAttempts);
}

/** Milliseconds until `canRequestLocation` turns true again; 0 when it already is. */
export function requestCooldownRemainingMs(record: LocationConsentRecord, now: number): number {
  if (canRequestLocation(record, now)) return 0;
  if (record.state === 'denied' || record.state === 'unavailable') return Number.POSITIVE_INFINITY;
  const elapsed = now - (record.lastRequestedAt ?? now);
  return Math.max(0, retryCooldownMs(record.failedAttempts) - elapsed);
}

export type LocationConsentEvent =
  | { type: 'requested'; at: number }
  | { type: 'granted' }
  | { type: 'failed'; failure: LocationConsentFailure }
  /** The Permissions API reported the browser-held state without prompting. */
  | { type: 'observed'; state: LocationPermissionState }
  /**
   * The user says they changed the browser setting. Without the Permissions API
   * there is no way to confirm that, and a remembered denial would otherwise be
   * permanent, so their word re-opens exactly one attempt. It cannot loop: the
   * event only ever comes from a button press, and a still-denied request lands
   * back on `denied`.
   */
  | { type: 'retry-allowed' };

export function reduceLocationConsent(
  record: LocationConsentRecord,
  event: LocationConsentEvent,
): LocationConsentRecord {
  switch (event.type) {
    case 'requested':
      return { ...record, lastRequestedAt: event.at };
    case 'granted':
      return { ...record, state: 'granted', failedAttempts: 0, lastFailure: null };
    case 'failed': {
      // A missing fix says nothing about permission, so the state only moves for
      // outcomes that are actually about access.
      const state: LocationPermissionState =
        event.failure === 'denied'
          ? 'denied'
          : event.failure === 'unavailable'
            ? 'unavailable'
            : record.state;
      return {
        ...record,
        state,
        // A denial is not retryable, so counting it would only inflate the
        // cooldown of a later, legitimate retry after the user changes settings.
        failedAttempts: event.failure === 'denied' ? 0 : record.failedAttempts + 1,
        lastFailure: event.failure,
      };
    }
    case 'observed': {
      // The browser is authoritative: it knows about grants and revocations made
      // in settings, which our own record cannot see.
      if (event.state === 'unknown') return record;
      const cleared = event.state === 'granted' || event.state === 'prompt';
      return {
        ...record,
        state: event.state,
        failedAttempts: cleared ? 0 : record.failedAttempts,
        lastFailure: cleared ? null : record.lastFailure,
      };
    }
    case 'retry-allowed': {
      // `unavailable` means there is no API to call at all, so nothing the user
      // does in settings can help; only a denial is worth re-opening.
      if (record.state !== 'denied') return record;
      return { state: 'prompt', lastRequestedAt: null, failedAttempts: 0, lastFailure: null };
    }
  }
}

export const LOCATION_CONSENT_MESSAGES: Record<LocationPermissionState, string> = {
  unknown: 'Location access has not been requested yet.',
  prompt: 'Your browser will ask for location access when you allow it below.',
  granted: 'Location access granted — runs can clear the fog and place reports at your position.',
  denied:
    'Location access is blocked for this site. Your browser will not ask again until you change it in site settings.',
  unavailable: 'This browser has no Geolocation API, so runs cannot track a position here.',
};

export function locationFailureMessage(failure: LocationConsentFailure): string {
  switch (failure) {
    case 'denied':
      return LOCATION_CONSENT_MESSAGES.denied;
    case 'position-unavailable':
      return 'Your device could not produce a position — indoors or with GPS off this is common. Try again outside.';
    case 'timeout':
      return 'The position request timed out before a fix arrived. Try again with a clear view of the sky.';
    case 'unavailable':
      return LOCATION_CONSENT_MESSAGES.unavailable;
  }
}

/** Maps a `GeolocationPositionError.code` onto a consent failure. */
export function geolocationFailure(code: number): LocationConsentFailure {
  // 1 PERMISSION_DENIED, 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
  if (code === 1) return 'denied';
  if (code === 3) return 'timeout';
  return 'position-unavailable';
}
