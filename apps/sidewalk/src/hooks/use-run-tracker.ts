'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REVEAL_RADIUS_M,
  createGpsFilter,
  fogCellBounds,
  fogCellIndexFromKey,
  fogCellsAround,
  gpsQuality,
  type Coordinate,
  type FogBounds,
  type GpsFilter,
  type GpsRejectReason,
} from '@sidewalk/core';
import { api } from '@/trpc/client';

/**
 * High-accuracy run tracking.
 *
 * `watchPosition` with `enableHighAccuracy: true` is the browser equivalent of
 * CoreLocation's `kCLLocationAccuracyBestForNavigation`: it turns the GNSS chip on
 * and streams fixes as the device moves, at a battery cost — so the watch only
 * runs while a run is active and is always cleared on stop/unmount.
 * Fixes go through the shared filter in @sidewalk/core before they touch the fog.
 */
export interface RunStatus {
  active: boolean;
  permission: 'unknown' | 'granted' | 'denied' | 'unavailable';
  error: string | null;
  lastRejection: GpsRejectReason | null;
  fixes: number;
  distanceM: number;
  accuracyM: number | null;
  quality: 'precise' | 'coarse' | 'poor';
}

const REVEAL_FLUSH_MS = 3_000;
const REVEAL_FLUSH_POINTS = 8;

/**
 * All mutable run state lives in one object per run, so a `stop` that is still
 * awaiting the network cannot touch the state of a run started after it.
 */
interface RunState {
  id: number;
  filter: GpsFilter;
  pending: Coordinate[];
  pendingAccuracyM: number | null;
  path: Coordinate[];
  traceId: string | null;
  tracePromise: Promise<string | null> | null;
  inFlightFlush: Promise<void> | null;
  watchId: number | null;
  flushTimer: ReturnType<typeof setInterval> | null;
}

export interface UseRunTrackerOptions {
  revealRadiusM?: number;
  onRevealed?: () => void;
}

export function useRunTracker({
  revealRadiusM = DEFAULT_REVEAL_RADIUS_M,
  onRevealed,
}: UseRunTrackerOptions = {}) {
  const [status, setStatus] = useState<RunStatus>({
    active: false,
    permission: 'unknown',
    error: null,
    lastRejection: null,
    fixes: 0,
    distanceM: 0,
    accuracyM: null,
    quality: 'coarse',
  });
  const [position, setPosition] = useState<(Coordinate & { accuracyM: number | null }) | null>(null);
  const [path, setPath] = useState<Coordinate[]>([]);
  const [localCellKeys, setLocalCellKeys] = useState<string[]>([]);

  const [traceId, setTraceId] = useState<string | null>(null);

  const runRef = useRef<RunState | null>(null);
  const runIdRef = useRef(0);

  const reveal = api.coverage.reveal.useMutation({
    onSuccess: () => onRevealed?.(),
  });
  const startTrace = api.trace.start.useMutation();
  const finishTrace = api.trace.finish.useMutation();
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  const flush = useCallback(
    async (run: RunState): Promise<void> => {
      // Serialised: overlapping flushes would reorder points and lose retries.
      if (run.inFlightFlush) return run.inFlightFlush;
      if (run.pending.length === 0) return;

      const send = (async () => {
        try {
          // The trace opens alongside the first fixes; waiting for it keeps the
          // whole run's coverage attributed to the run that collected it.
          if (!run.traceId && run.tracePromise) await run.tracePromise;

          // Drains points queued while a request was in flight, so stopping
          // never leaves coverage behind.
          while (run.pending.length > 0) {
            const points = run.pending;
            run.pending = [];
            const accuracyM = run.pendingAccuracyM ?? undefined;
            run.pendingAccuracyM = null;
            try {
              await revealRef.current.mutateAsync({
                points,
                revealRadiusM,
                accuracyM,
                traceId: run.traceId ?? undefined,
              });
            } catch {
              // Requeue ahead of anything accepted meanwhile, so a transient
              // outage delays coverage instead of losing it.
              run.pending = [...points, ...run.pending];
              if (accuracyM != null) {
                run.pendingAccuracyM = Math.min(
                  run.pendingAccuracyM ?? Number.POSITIVE_INFINITY,
                  accuracyM,
                );
              }
              break;
            }
          }
        } finally {
          run.inFlightFlush = null;
        }
      })();
      run.inFlightFlush = send;
      return send;
    },
    [revealRadiusM],
  );

  const stop = useCallback(async () => {
    const run = runRef.current;
    runRef.current = null;
    setStatus((s) => ({ ...s, active: false }));
    setTraceId(null);
    if (!run) return;

    if (run.watchId != null && typeof navigator !== 'undefined') {
      navigator.geolocation.clearWatch(run.watchId);
      run.watchId = null;
    }
    if (run.flushTimer) {
      clearInterval(run.flushTimer);
      run.flushTimer = null;
    }

    // The trace may still be opening: awaiting it keeps the last flush and the
    // close attributed to this run rather than orphaning them.
    run.traceId = run.traceId ?? (await run.tracePromise) ?? null;
    // Retried so the last fixes are persisted before the trace is closed; the
    // flush timer is gone, so nothing else would pick them up.
    for (let attempt = 0; attempt < 3 && run.pending.length > 0; attempt += 1) {
      await flush(run);
    }

    if (run.traceId && run.path.length >= 1) {
      try {
        await finishTrace.mutateAsync({ traceId: run.traceId, points: run.path });
      } catch {
        // A failed trace close must not lose the run: the fog is already saved.
      }
    }
  }, [flush, finishTrace]);
  const stopRef = useRef(stop);
  stopRef.current = stop;

  /**
   * A trace is opened on the first accepted fix rather than on start, so a run
   * that never gets GPS (permission denied, no signal) leaves no empty trace.
   */
  const ensureTrace = useCallback(
    (run: RunState) => {
      if (run.tracePromise) return;
      run.tracePromise = startTrace
        .mutateAsync({ startedAt: new Date() })
        .then((trace) => {
          run.traceId = trace.id;
          if (runRef.current === run) setTraceId(trace.id);
          return trace.id;
        })
        .catch(() => null);
    },
    [startTrace],
  );

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus((s) => ({
        ...s,
        permission: 'unavailable',
        error: 'This browser has no Geolocation API.',
      }));
      return;
    }

    // A second start without a stop would orphan the previous watch and timer.
    if (runRef.current) void stopRef.current();

    runIdRef.current += 1;
    const run: RunState = {
      id: runIdRef.current,
      filter: createGpsFilter(),
      pending: [],
      pendingAccuracyM: null,
      path: [],
      traceId: null,
      tracePromise: null,
      inFlightFlush: null,
      watchId: null,
      flushTimer: null,
    };
    runRef.current = run;
    setTraceId(null);
    setPosition(null);
    setPath([]);
    setLocalCellKeys([]);
    setStatus((s) => ({
      ...s,
      active: true,
      error: null,
      lastRejection: null,
      fixes: 0,
      distanceM: 0,
    }));

    run.watchId = navigator.geolocation.watchPosition(
      (fix) => {
        if (runRef.current !== run) return;
        const { filter } = run;
        const result = filter.push({
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          accuracyM: fix.coords.accuracy,
          timestamp: fix.timestamp,
        });

        if (!result.accepted) {
          setStatus((s) => ({
            ...s,
            permission: 'granted',
            lastRejection: result.reason,
            accuracyM: fix.coords.accuracy ?? null,
            quality: gpsQuality(fix.coords.accuracy),
          }));
          return;
        }

        ensureTrace(run);
        const point = { lat: result.fix.lat, lng: result.fix.lng };
        run.pending = [...run.pending, point];
        run.path = [...run.path, point];
        // Only accepted, smoothed fixes move the runner: voice geocoding, the
        // live fog hole and map following all read this position.
        setPosition({ ...point, accuracyM: result.fix.accuracyM ?? null });
        const accuracyM = result.fix.accuracyM;
        if (accuracyM != null) {
          run.pendingAccuracyM = Math.min(run.pendingAccuracyM ?? Number.POSITIVE_INFINITY, accuracyM);
        }
        setPath((current) => [...current, point]);
        setLocalCellKeys((current) => {
          const next = new Set(current);
          for (const key of fogCellsAround(point, revealRadiusM)) next.add(key);
          return [...next];
        });
        setStatus((s) => ({
          ...s,
          permission: 'granted',
          lastRejection: null,
          error: null,
          fixes: s.fixes + 1,
          distanceM: filter.trackDistanceM,
          accuracyM: result.fix.accuracyM ?? null,
          quality: gpsQuality(result.fix.accuracyM),
        }));

        if (run.pending.length >= REVEAL_FLUSH_POINTS) void flush(run);
      },
      (error) => {
        if (runRef.current !== run) return;
        const denied = error.code === error.PERMISSION_DENIED;
        setStatus((s) => ({
          ...s,
          permission: denied ? 'denied' : s.permission,
          error: denied
            ? 'Location permission denied — the fog can only clear with GPS access.'
            : error.message || 'Could not get a GPS fix.',
        }));
        // Denial is terminal: tear the run down through the same path as stop so
        // no watch, timer or empty trace is left behind.
        if (denied) void stopRef.current();
      },
      // enableHighAccuracy: GNSS instead of Wi-Fi/cell triangulation.
      // maximumAge 0: never reuse a cached fix, we want where the runner is now.
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );

    run.flushTimer = setInterval(() => void flush(run), REVEAL_FLUSH_MS);
  }, [ensureTrace, flush, revealRadiusM]);

  useEffect(
    () => () => {
      // Best effort: React cleanup cannot await, so the final flush and trace
      // close race the teardown. Coverage already persisted is unaffected.
      if (runRef.current) void stopRef.current();
    },
    [],
  );

  /** Locally revealed cells, drawn before the server round-trip completes. */
  const localBounds = useMemo<FogBounds[]>(() => {
    const bounds: FogBounds[] = [];
    for (const key of localCellKeys) {
      const index = fogCellIndexFromKey(key);
      if (index) bounds.push(fogCellBounds(index));
    }
    return bounds;
  }, [localCellKeys]);

  return {
    status,
    position,
    path,
    /** The active run's trace, once opened, so reports can be linked to it. */
    traceId,
    localBounds,
    revealRadiusM,
    revealPending: reveal.isPending,
    revealError: reveal.error?.message ?? null,
    start,
    stop,
  };
}
