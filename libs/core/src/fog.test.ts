import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVEAL_RADIUS_M,
  fogCellBounds,
  fogCellIndex,
  fogCellIndexFromKey,
  fogCellKey,
  fogCellsAlongPath,
  fogCellsAround,
  fogCellAreaM2,
  fogClearedAreaM2,
} from './fog';
import { distanceMeters } from './geo';

const CENTER = { lat: 52.5208, lng: 13.4095 };

describe('fogCellKey', () => {
  it('is stable for coordinates inside the same cell', () => {
    expect(fogCellKey({ lat: 52.520801, lng: 13.409501 })).toBe(
      fogCellKey({ lat: 52.520805, lng: 13.409505 }),
    );
  });

  it('differs for neighbouring cells', () => {
    expect(fogCellKey(CENTER)).not.toBe(fogCellKey({ lat: CENTER.lat + 0.001, lng: CENTER.lng }));
  });

  it('round-trips through the index', () => {
    const key = fogCellKey(CENTER);
    expect(fogCellIndexFromKey(key)).toEqual(fogCellIndex(CENTER));
  });

  it('rejects malformed keys', () => {
    expect(fogCellIndexFromKey('nonsense')).toBeNull();
  });
});

describe('fogCellBounds', () => {
  it('contains the coordinate it was derived from', () => {
    const bounds = fogCellBounds(fogCellIndex(CENTER));
    expect(CENTER.lat).toBeGreaterThanOrEqual(bounds.minLat);
    expect(CENTER.lat).toBeLessThan(bounds.maxLat);
    expect(CENTER.lng).toBeGreaterThanOrEqual(bounds.minLng);
    expect(CENTER.lng).toBeLessThan(bounds.maxLng);
  });
});

describe('fogCellsAround', () => {
  it('reveals the cell the runner stands in', () => {
    expect(fogCellsAround(CENTER)).toContain(fogCellKey(CENTER));
  });

  it('reveals more cells for a wider radius', () => {
    expect(fogCellsAround(CENTER, 60).length).toBeGreaterThan(fogCellsAround(CENTER, 15).length);
  });

  it('returns the cell the runner stands in first, then outwards', () => {
    const keys = fogCellsAround(CENTER, DEFAULT_REVEAL_RADIUS_M);
    expect(keys[0]).toBe(fogCellKey(CENTER));
    const distances = keys.slice(1).map((key) => {
      const bounds = fogCellBounds(fogCellIndexFromKey(key)!);
      return distanceMeters(CENTER, {
        lat: (bounds.minLat + bounds.maxLat) / 2,
        lng: (bounds.minLng + bounds.maxLng) / 2,
      });
    });
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it('never reveals a cell centre outside the radius', () => {
    for (const key of fogCellsAround(CENTER, DEFAULT_REVEAL_RADIUS_M)) {
      const index = fogCellIndexFromKey(key);
      expect(index).not.toBeNull();
      const bounds = fogCellBounds(index!);
      const center = { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 };
      expect(distanceMeters(CENTER, center)).toBeLessThanOrEqual(DEFAULT_REVEAL_RADIUS_M);
    }
  });
});

describe('fogCellsAlongPath', () => {
  it('de-duplicates overlapping reveals', () => {
    const path = [CENTER, { lat: CENTER.lat + 0.00005, lng: CENTER.lng }];
    const combined = fogCellsAlongPath(path, 20);
    expect(new Set(combined).size).toBe(combined.length);
    expect(combined.length).toBeLessThan(fogCellsAround(path[0]!, 20).length * 2);
  });

  it('grows as the runner moves down a street', () => {
    const straight = Array.from({ length: 10 }, (_, i) => ({
      lat: CENTER.lat,
      lng: CENTER.lng + i * 0.0005,
    }));
    expect(fogCellsAlongPath(straight, 20).length).toBeGreaterThan(fogCellsAround(CENTER, 20).length);
  });
});

describe('fogClearedAreaM2', () => {
  it('scales linearly with cell count at one latitude', () => {
    const lats = [CENTER.lat, CENTER.lat, CENTER.lat, CENTER.lat];
    expect(fogClearedAreaM2(lats)).toBeCloseTo(fogClearedAreaM2([CENTER.lat]) * 4);
  });

  it('shrinks with latitude as meridians converge', () => {
    // cos(52.52°) ≈ 0.608, so a Berlin cell is far smaller than an equatorial one.
    expect(fogCellAreaM2(CENTER.lat)).toBeCloseTo(fogCellAreaM2(0) * Math.cos((CENTER.lat * Math.PI) / 180), 3);
    expect(fogCellAreaM2(60)).toBeLessThan(fogCellAreaM2(CENTER.lat));
  });
});
