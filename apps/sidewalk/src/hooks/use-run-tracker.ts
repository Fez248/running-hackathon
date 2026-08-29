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

  const watchIdRef = useRef<number | null>(null);
  const filterRef = useRef<GpsFilter | null>(null);
  const pendingRef = useRef<Coordinate[]>([]);
  const pendingAccuracyRef = useRef<number | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const traceIdRef = useRef<string | null>(null);
  const tracePromiseRef = useRef<Promise<string | null> | null>(null);
  const pathRef = useRef<Coordinate[]>([]);
  const inFlightFlushRef = useRef<Promise<void> | null>(null);
  /** Bumped on every start/stop so callbacks of a finished run can't write refs. */
  const runIdRef = useRef(0);

  const reveal = api.coverage.reveal.useMutation({
    onSuccess: () => onRevealed?.(),
  });
  const startTrace = api.trace.start.useMutation();
  const finishTrace = api.trace.finish.useMutation();
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  const flush = useCallback(async (): Promise<void> => {
    // Serialised: overlapping flushes would reorder points and lose retries.
    if (inFlightFlushRef.current) return inFlightFlushRef.current;
    const points = pendingRef.current;
    if (points.length === 0) return;
    pendingRef.current = [];
    const accuracyM = pendingAccuracyRef.current ?? undefined;
    pendingAccuracyRef.current = null;

    const run = (async () => {
      try {
        await revealRef.current.mutateAsync({
          points,
          revealRadiusM,
          accuracyM,
          traceId: traceIdRef.current ?? undefined,
        });
      } catch {
        // Requeue ahead of anything accepted meanwhile, so a transient outage
        // delays coverage instead of losing it.
        pendingRef.current = [...points, ...pendingRef.current];
        if (accuracyM != null) {
          pendingAccuracyRef.current = Math.min(
            pendingAccuracyRef.current ?? Number.POSITIVE_INFINITY,
            accuracyM,
          );
        }
      } finally {
        inFlightFlushRef.current = null;
      }
    })();
    inFlightFlushRef.current = run;
    return run;
  }, [revealRadiusM]);

  const stop = useCallback(
    async () => {
      runIdRef.current += 1;
      if (watchIdRef.current != null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      setStatus((s) => ({ ...s, active: false }));

      // The trace may still be opening: awaiting it keeps the last flush and the
      // close attributed to this run rather than orphaning them.
      const traceId = traceIdRef.current ?? (await tracePromiseRef.current) ?? null;
      traceIdRef.current = traceId;
      // Awaited so the last fixes are persisted before the trace is closed.
      await flush();
      await inFlightFlushRef.current;
      traceIdRef.current = null;
      tracePromiseRef.current = null;

      const points = pathRef.current;
      if (traceId && points.length >= 1) {
        try {
          await finishTrace.mutateAsync({ traceId, points });
        } catch {
          // A failed trace close must not lose the run: the fog is already saved.
        }
      }
    },
    [flush, finishTrace],
  );
  const stopRef = useRef(stop);
  stopRef.current = stop;

  /**
   * A trace is opened on the first accepted fix rather than on start, so a run
   * that never gets GPS (permission denied, no signal) leaves no empty trace.
   */
  const ensureTrace = useCallback(
    (runId: number) => {
      if (tracePromiseRef.current) return;
      tracePromiseRef.current = startTrace
        .mutateAsync({ startedAt: new Date() })
        .then((trace) => {
          if (runIdRef.current !== runId) return null;
          traceIdRef.current = trace.id;
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

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    filterRef.current = createGpsFilter();
    pendingRef.current = [];
    pendingAccuracyRef.current = null;
    traceIdRef.current = null;
    tracePromiseRef.current = null;
    pathRef.current = [];
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

    watchIdRef.current = navigator.geolocation.watchPosition(
      (fix) => {
        const filter = filterRef.current;
        if (!filter) return;
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

        ensureTrace(runId);
        const point = { lat: result.fix.lat, lng: result.fix.lng };
        pendingRef.current.push(point);
        pathRef.current = [...pathRef.current, point];
        // Only accepted, smoothed fixes move the runner: voice geocoding, the
        // live fog hole and map following all read this position.
        setPosition({ ...point, accuracyM: result.fix.accuracyM ?? null });
        const accuracyM = result.fix.accuracyM;
        if (accuracyM != null) {
          pendingAccuracyRef.current = Math.min(
            pendingAccuracyRef.current ?? Number.POSITIVE_INFINITY,
            accuracyM,
          );
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

        if (pendingRef.current.length >= REVEAL_FLUSH_POINTS) void flush();
      },
      (error) => {
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

    flushTimerRef.current = setInterval(() => void flush(), REVEAL_FLUSH_MS);
  }, [ensureTrace, flush, revealRadiusM]);

  useEffect(
    () => () => {
      if (watchIdRef.current != null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
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
    localBounds,
    revealRadiusM,
    revealPending: reveal.isPending,
    revealError: reveal.error?.message ?? null,
    start,
    stop,
  };
}
