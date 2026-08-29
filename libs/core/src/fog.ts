import { boundsAround, distanceMeters } from './geo';
import type { Coordinate } from './obstacles';

/**
 * Fog of War grid.
 *
 * The map starts fully fogged; a cell is revealed once a GPS fix lands within
 * `revealRadiusM` of it. Cells are a fixed number of degrees so a key is stable
 * across clients, devices and database rows (SQLite has no spatial types, so the
 * key doubles as the index).
 */
export const FOG_CELL_SIZE_DEG = 0.00025;

/** Metres per degree of latitude, good enough for cell-sized maths. */
const METERS_PER_DEG_LAT = 111_320;

/** Approximate side length of a fog cell in metres, at the equator. */
export const FOG_CELL_SIZE_M = FOG_CELL_SIZE_DEG * METERS_PER_DEG_LAT;

/** Default radius around a GPS fix that gets revealed (a street's width). */
export const DEFAULT_REVEAL_RADIUS_M = 25;

export interface FogCellIndex {
  x: number;
  y: number;
}

export interface FogBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export function fogCellIndex(coord: Coordinate): FogCellIndex {
  return {
    x: Math.floor(coord.lng / FOG_CELL_SIZE_DEG),
    y: Math.floor(coord.lat / FOG_CELL_SIZE_DEG),
  };
}

/** Stable identifier of a fog cell, used as the primary key in the database. */
export function fogCellKey(coord: Coordinate): string {
  const { x, y } = fogCellIndex(coord);
  return `${y}_${x}`;
}

export function fogCellKeyFromIndex(index: FogCellIndex): string {
  return `${index.y}_${index.x}`;
}

export function fogCellIndexFromKey(key: string): FogCellIndex | null {
  const [y, x] = key.split('_');
  if (y === undefined || x === undefined) return null;
  const yi = Number(y);
  const xi = Number(x);
  if (!Number.isInteger(yi) || !Number.isInteger(xi)) return null;
  return { x: xi, y: yi };
}

export function fogCellBounds(index: FogCellIndex): FogBounds {
  return {
    minLat: index.y * FOG_CELL_SIZE_DEG,
    maxLat: (index.y + 1) * FOG_CELL_SIZE_DEG,
    minLng: index.x * FOG_CELL_SIZE_DEG,
    maxLng: (index.x + 1) * FOG_CELL_SIZE_DEG,
  };
}

export function fogCellCenter(index: FogCellIndex): Coordinate {
  const b = fogCellBounds(index);
  return { lat: (b.minLat + b.maxLat) / 2, lng: (b.minLng + b.maxLng) / 2 };
}

/**
 * Cells revealed by standing at `coord`: every cell whose centre is within
 * `radiusM`. Iterating the bounding box keeps this allocation-free enough to run
 * on every GPS tick.
 */
export function fogCellsAround(coord: Coordinate, radiusM = DEFAULT_REVEAL_RADIUS_M): string[] {
  const box = boundsAround(coord, radiusM);
  const from = fogCellIndex({ lat: box.minLat, lng: box.minLng });
  const to = fogCellIndex({ lat: box.maxLat, lng: box.maxLng });

  const keys: string[] = [];
  for (let y = from.y; y <= to.y; y += 1) {
    for (let x = from.x; x <= to.x; x += 1) {
      const index = { x, y };
      if (distanceMeters(coord, fogCellCenter(index)) <= radiusM) {
        keys.push(fogCellKeyFromIndex(index));
      }
    }
  }
  return keys;
}

/** Cells revealed by a whole path, de-duplicated. */
export function fogCellsAlongPath(
  path: readonly Coordinate[],
  radiusM = DEFAULT_REVEAL_RADIUS_M,
): string[] {
  const keys = new Set<string>();
  for (const point of path) {
    for (const key of fogCellsAround(point, radiusM)) keys.add(key);
  }
  return [...keys];
}

/** Cleared area in m², used for the "explored" stat. */
export function fogClearedAreaM2(cellCount: number): number {
  return cellCount * FOG_CELL_SIZE_M * FOG_CELL_SIZE_M;
}
