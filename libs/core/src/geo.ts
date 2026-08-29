import type { Coordinate } from './obstacles';

const EARTH_RADIUS_M = 6_371_008.8;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceMeters(a: Coordinate, b: Coordinate): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounding box around a point, used for "nearby" lookups and dedupe. */
export function boundsAround(center: Coordinate, radiusM: number) {
  const latDelta = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const lngDelta = latDelta / Math.max(Math.cos(toRadians(center.lat)), 1e-6);
  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLng: center.lng - lngDelta,
    maxLng: center.lng + lngDelta,
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Fold an out-of-range longitude into [-180, 180). */
const wrapLongitude = (lng: number): number =>
  lng >= -180 && lng <= 180 ? lng : ((((lng + 180) % 360) + 360) % 360) - 180;

/**
 * Normalise a map viewport into valid WGS84 ranges. Map libraries report
 * unwrapped bounds — a world copy to the east reads 190..210, a view straddling
 * the antimeridian reads 170..190 — which the bounds schemas reject. World
 * offsets are wrapped back onto the real longitudes; a straddling view, which a
 * single min/max interval cannot express, widens to the whole world so that no
 * visible report is dropped from the result.
 */
export function clampBounds(bounds: {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}) {
  const south = clamp(Math.min(bounds.minLat, bounds.maxLat), -90, 90);
  const north = clamp(Math.max(bounds.minLat, bounds.maxLat), -90, 90);
  const wholeWorld = { minLat: south, maxLat: north, minLng: -180, maxLng: 180 };
  if (bounds.maxLng - bounds.minLng >= 360) return wholeWorld;

  const west = wrapLongitude(bounds.minLng);
  const east = wrapLongitude(bounds.maxLng);
  if (west > east) return wholeWorld;
  return { minLat: south, maxLat: north, minLng: west, maxLng: east };
}

/**
 * Snap a coordinate to a fixed grid so that reports captured at speed cluster
 * into the same sidewalk feature. ~1e-4 degrees is roughly 11 m.
 */
export function gridKey(coord: Coordinate, precision = 4): string {
  return `${coord.lat.toFixed(precision)}:${coord.lng.toFixed(precision)}`;
}
