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
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<Date | null>(null);

  const reveal = api.coverage.reveal.useMutation({
    onSuccess: () => onRevealed?.(),
  });
  const uploadTrace = api.trace.upload.useMutation();
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  const flush = useCallback(() => {
    const points = pendingRef.current;
    if (points.length === 0) return;
    pendingRef.current = [];
    revealRef.current.mutate({ points, revealRadiusM });
  }, [revealRadiusM]);

  const stop = useCallback(
    async ({ upload = true }: { upload?: boolean } = {}) => {
      if (watchIdRef.current != null && typeof navigator !== 'undefined') {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      if (flushTimerRef.current) {
        clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flush();

      const points = path;
      const startedAt = startedAtRef.current;
      startedAtRef.current = null;
      setStatus((s) => ({ ...s, active: false }));

      if (upload && points.length >= 2) {
        try {
          await uploadTrace.mutateAsync({ points, startedAt: startedAt ?? undefined });
        } catch {
          // A failed trace upload must not lose the run: the fog is already saved.
        }
      }
    },
    [flush, path, uploadTrace],
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

    filterRef.current = createGpsFilter();
    pendingRef.current = [];
    startedAtRef.current = new Date();
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

        setPosition({
          lat: fix.coords.latitude,
          lng: fix.coords.longitude,
          accuracyM: fix.coords.accuracy ?? null,
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

        const point = { lat: result.fix.lat, lng: result.fix.lng };
        pendingRef.current.push(point);
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

        if (pendingRef.current.length >= REVEAL_FLUSH_POINTS) flush();
      },
      (error) => {
        setStatus((s) => ({
          ...s,
          active: error.code !== error.PERMISSION_DENIED && s.active,
          permission: error.code === error.PERMISSION_DENIED ? 'denied' : s.permission,
          error:
            error.code === error.PERMISSION_DENIED
              ? 'Location permission denied — the fog can only clear with GPS access.'
              : error.message || 'Could not get a GPS fix.',
        }));
      },
      // enableHighAccuracy: GNSS instead of Wi-Fi/cell triangulation.
      // maximumAge 0: never reuse a cached fix, we want where the runner is now.
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );

    flushTimerRef.current = setInterval(flush, REVEAL_FLUSH_MS);
  }, [flush, revealRadiusM]);

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
