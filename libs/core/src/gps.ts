import { distanceMeters } from './geo';
import type { Coordinate } from './obstacles';

/**
 * High-accuracy GPS handling for in-run tracking.
 *
 * A phone watching position with `enableHighAccuracy: true` still emits noisy
 * fixes: a coarse network fix while the GNSS chip warms up, teleports of tens of
 * metres between buildings, and jitter while standing still. Feeding those raw
 * into the Fog of War would reveal streets the runner never touched, so every fix
 * goes through this filter first.
 */
export interface GpsFix extends Coordinate {
  /** Reported horizontal accuracy in metres (68% confidence radius). */
  accuracyM?: number | null;
  /** Epoch millis of the fix. */
  timestamp: number;
}

export type GpsRejectReason = 'inaccurate' | 'implausible-speed' | 'too-close';

export interface GpsFilterOptions {
  /** Fixes worse than this are dropped outright. */
  maxAccuracyM: number;
  /** Faster than this between two fixes means the fix teleported. */
  maxSpeedMps: number;
  /** Ignore fixes closer than this to the last accepted one (jitter). */
  minDistanceM: number;
}

export const DEFAULT_GPS_FILTER_OPTIONS: GpsFilterOptions = {
  // A good urban GNSS fix is 5-15 m; beyond ~30 m it is a Wi-Fi/cell estimate.
  maxAccuracyM: 30,
  // ~43 km/h: faster than any runner, slower than a jump between two cell towers.
  maxSpeedMps: 12,
  minDistanceM: 4,
};

export type GpsFilterResult =
  | { accepted: true; fix: GpsFix; distanceM: number }
  | { accepted: false; reason: GpsRejectReason };

/**
 * Smoothing weight for a new fix: a tight fix is trusted almost fully, a loose
 * one only nudges the smoothed position.
 */
export function smoothingWeight(accuracyM: number | null | undefined): number {
  if (accuracyM == null) return 0.5;
  if (accuracyM <= 5) return 0.9;
  if (accuracyM >= 30) return 0.2;
  return 0.9 - ((accuracyM - 5) / 25) * 0.7;
}

/** Exponential position smoothing, weighted by the new fix's accuracy. */
export function smoothFix(previous: GpsFix, next: GpsFix): GpsFix {
  const w = smoothingWeight(next.accuracyM);
  return {
    lat: previous.lat + (next.lat - previous.lat) * w,
    lng: previous.lng + (next.lng - previous.lng) * w,
    accuracyM: next.accuracyM,
    timestamp: next.timestamp,
  };
}

/**
 * Stateful filter over a stream of fixes. Keeps only the last accepted fix, so it
 * is cheap to run inside a `watchPosition` callback.
 */
export function createGpsFilter(options: Partial<GpsFilterOptions> = {}) {
  const config = { ...DEFAULT_GPS_FILTER_OPTIONS, ...options };
  let last: GpsFix | null = null;
  let distanceM = 0;

  return {
    get last(): GpsFix | null {
      return last;
    },
    /** Total distance of the accepted track in metres. */
    get trackDistanceM(): number {
      return distanceM;
    },
    reset(): void {
      last = null;
      distanceM = 0;
    },
    push(fix: GpsFix): GpsFilterResult {
      if (fix.accuracyM != null && fix.accuracyM > config.maxAccuracyM) {
        return { accepted: false, reason: 'inaccurate' };
      }

      if (!last) {
        last = fix;
        return { accepted: true, fix, distanceM: 0 };
      }

      const moved = distanceMeters(last, fix);
      const elapsedS = Math.max((fix.timestamp - last.timestamp) / 1000, 0.001);
      if (moved / elapsedS > config.maxSpeedMps) {
        return { accepted: false, reason: 'implausible-speed' };
      }
      if (moved < config.minDistanceM) {
        return { accepted: false, reason: 'too-close' };
      }

      const smoothed = smoothFix(last, fix);
      distanceM += distanceMeters(last, smoothed);
      last = smoothed;
      return { accepted: true, fix: smoothed, distanceM: moved };
    },
  };
}

export type GpsFilter = ReturnType<typeof createGpsFilter>;

/** Human-readable quality label for the accuracy badge in the UI. */
export function gpsQuality(accuracyM: number | null | undefined): 'precise' | 'coarse' | 'poor' {
  if (accuracyM == null) return 'coarse';
  if (accuracyM <= 10) return 'precise';
  if (accuracyM <= 30) return 'coarse';
  return 'poor';
}
