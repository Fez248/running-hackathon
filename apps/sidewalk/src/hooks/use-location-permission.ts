'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canRequestLocation,
  geolocationFailure,
  initialLocationConsent,
  locationFailureMessage,
  parseLocationConsent,
  reduceLocationConsent,
  requestCooldownRemainingMs,
  type LocationConsentEvent,
  type LocationConsentRecord,
  type LocationPermissionState,
} from '@sidewalk/core';

/**
 * Location consent for the run tracker.
 *
 * Chrome only raises its location prompt in response to a user gesture, and once
 * the user has denied it the prompt never appears again for the origin — further
 * calls fail immediately. So permission is asked for explicitly, from a button,
 * and the outcome is remembered: after a denial the UI explains the site-settings
 * path instead of firing another request the browser will refuse.
 *
 * `navigator.permissions` is consulted where available because it is the only way
 * to notice a grant or revocation the user made in settings, and it reports the
 * state *without* prompting.
 *
 * Privacy: the consent probe asks for a low-cost, cached-if-recent fix purely to
 * learn whether access is allowed. The coordinate is discarded — only runs record
 * positions, and only the consent outcome is persisted.
 */

const STORAGE_KEY = 'sidewalk.location-consent.v1';
/** The probe only needs "may I", so a cached fix and a short timeout are fine. */
const PROBE_OPTIONS: PositionOptions = {
  enableHighAccuracy: false,
  maximumAge: 60_000,
  timeout: 10_000,
};

function readStored(): LocationConsentRecord {
  if (typeof window === 'undefined') return initialLocationConsent();
  try {
    return parseLocationConsent(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be disabled entirely (private mode, blocked cookies); consent
    // then simply lives for the session.
    return initialLocationConsent();
  }
}

function persist(record: LocationConsentRecord) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* ignore: a non-persisted record only means we may ask again next visit */
  }
}

export interface LocationPermission {
  state: LocationPermissionState;
  /** True while the browser prompt (or the probe behind it) is outstanding. */
  requesting: boolean;
  /** Set when the last attempt failed, already phrased for a user. */
  error: string | null;
  /** False when asking again cannot help: denied, unavailable, or cooling down. */
  canRequest: boolean;
  cooldownMs: number;
  /** Whether the Permissions API can report the browser-held state. */
  observable: boolean;
  /** Raises the browser prompt. Must be called from a user gesture. */
  request: () => Promise<LocationPermissionState>;
  /** Re-reads the browser-held state without prompting (the "I fixed it" path). */
  recheck: () => Promise<LocationPermissionState>;
}

export function useLocationPermission(): LocationPermission {
  const [record, setRecord] = useState<LocationConsentRecord>(initialLocationConsent);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [observable, setObservable] = useState(false);
  const recordRef = useRef(record);
  recordRef.current = record;

  const apply = useCallback((event: LocationConsentEvent) => {
    const next = reduceLocationConsent(recordRef.current, event);
    recordRef.current = next;
    setRecord(next);
    persist(next);
    return next;
  }, []);

  const observe = useCallback(async (): Promise<LocationPermissionState> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return apply({ type: 'failed', failure: 'unavailable' }).state;
    }
    if (!navigator.permissions?.query) return recordRef.current.state;
    try {
      const status = await navigator.permissions.query({ name: 'geolocation' });
      return apply({ type: 'observed', state: status.state as LocationPermissionState }).state;
    } catch {
      // Some browsers reject the geolocation descriptor; the record stands.
      return recordRef.current.state;
    }
  }, [apply]);

  // Hydrate from storage on the client only, so the server-rendered markup and
  // the first client render agree.
  useEffect(() => {
    const stored = readStored();
    recordRef.current = stored;
    setRecord(stored);
    setObservable(
      typeof navigator !== 'undefined' && navigator.permissions?.query != null,
    );
    void observe();
  }, [observe]);

  // Follow grants and revocations made in browser settings while the tab is open.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (status) apply({ type: 'observed', state: status.state as LocationPermissionState });
    };
    void navigator.permissions
      .query({ name: 'geolocation' })
      .then((result) => {
        status = result;
        result.addEventListener('change', onChange);
      })
      .catch(() => undefined);
    return () => status?.removeEventListener('change', onChange);
  }, [apply]);

  // Only ticks while a cooldown is actually pending, so the button re-enables
  // itself without the panel re-rendering all the time.
  const cooldownMs = requestCooldownRemainingMs(record, now);
  const pendingCooldown = Number.isFinite(cooldownMs) && cooldownMs > 0;
  useEffect(() => {
    if (!pendingCooldown) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pendingCooldown]);

  const request = useCallback(async (): Promise<LocationPermissionState> => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      const next = apply({ type: 'failed', failure: 'unavailable' });
      setError(locationFailureMessage('unavailable'));
      return next.state;
    }
    const current = recordRef.current;
    if (current.state === 'granted') return 'granted';
    if (!canRequestLocation(current, Date.now())) {
      setNow(Date.now());
      return current.state;
    }

    setRequesting(true);
    setError(null);
    apply({ type: 'requested', at: Date.now() });
    try {
      return await new Promise<LocationPermissionState>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          () => {
            // The position itself is deliberately dropped: this call only
            // establishes consent, the run tracker collects the real track.
            resolve(apply({ type: 'granted' }).state);
          },
          (cause) => {
            const failure = geolocationFailure(cause.code);
            const next = apply({ type: 'failed', failure });
            setError(locationFailureMessage(failure));
            setNow(Date.now());
            resolve(next.state);
          },
          PROBE_OPTIONS,
        );
      });
    } finally {
      setRequesting(false);
    }
  }, [apply]);

  const recheck = useCallback(async () => {
    setError(null);
    const state = await observe();
    setNow(Date.now());
    return state;
  }, [observe]);

  return {
    state: record.state,
    requesting,
    error,
    canRequest: canRequestLocation(record, now) && !requesting,
    cooldownMs: Number.isFinite(cooldownMs) ? cooldownMs : 0,
    observable,
    request,
    recheck,
  };
}
