import { describe, expect, it } from 'vitest';
import { boundsAround, clampBounds, distanceMeters, gridKey } from './geo';
import { boundsSchema } from './obstacles';
import { confidence, passabilityForProfile } from './scoring';

describe('distanceMeters', () => {
  it('is zero for the same point', () => {
    expect(distanceMeters({ lat: 52.52, lng: 13.4 }, { lat: 52.52, lng: 13.4 })).toBe(0);
  });

  it('approximates 111 km per degree of latitude', () => {
    const d = distanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('boundsAround', () => {
  it('contains the centre', () => {
    const b = boundsAround({ lat: 52.52, lng: 13.4 }, 100);
    expect(b.minLat).toBeLessThan(52.52);
    expect(b.maxLat).toBeGreaterThan(52.52);
    expect(b.minLng).toBeLessThan(13.4);
    expect(b.maxLng).toBeGreaterThan(13.4);
  });
});

describe('clampBounds', () => {
  it('leaves a valid viewport untouched', () => {
    const viewport = { minLat: 52.5, maxLat: 52.54, minLng: 13.39, maxLng: 13.43 };
    expect(clampBounds(viewport)).toEqual(viewport);
  });

  it('accepts the unwrapped world bounds a zoomed-out map reports', () => {
    // Leaflet returns longitudes past ±180 once the whole world is visible.
    const clamped = clampBounds({
      minLat: -89.9,
      maxLat: 89.9,
      minLng: -227.8,
      maxLng: 227.8,
    });
    expect(clamped).toEqual({ minLat: -89.9, maxLat: 89.9, minLng: -180, maxLng: 180 });
    expect(boundsSchema.safeParse(clamped).success).toBe(true);
  });

  it('wraps a viewport panned into the next world copy onto its real longitudes', () => {
    expect(clampBounds({ minLat: 10, maxLat: 12, minLng: 190, maxLng: 210 })).toEqual({
      minLat: 10,
      maxLat: 12,
      minLng: -170,
      maxLng: -150,
    });
    expect(clampBounds({ minLat: 10, maxLat: 12, minLng: -210, maxLng: -190 })).toEqual({
      minLat: 10,
      maxLat: 12,
      minLng: 150,
      maxLng: 170,
    });
  });

  it('orders in-range edges that arrive reversed', () => {
    expect(clampBounds({ minLat: 12, maxLat: 10, minLng: 13.43, maxLng: 13.39 })).toEqual({
      minLat: 10,
      maxLat: 12,
      minLng: 13.39,
      maxLng: 13.43,
    });
  });

  it('widens a viewport straddling the antimeridian instead of truncating it', () => {
    // One min/max interval cannot express 170..-170, and dropping either half
    // would hide reports that are on screen.
    for (const straddling of [
      { minLat: 10, maxLat: 12, minLng: 170, maxLng: 190 },
      { minLat: 10, maxLat: 12, minLng: -190, maxLng: -170 },
    ]) {
      const clamped = clampBounds(straddling);
      expect(clamped).toEqual({ minLat: 10, maxLat: 12, minLng: -180, maxLng: 180 });
      expect(boundsSchema.safeParse(clamped).success).toBe(true);
    }
  });
});

describe('gridKey', () => {
  it('clusters nearby coordinates', () => {
    expect(gridKey({ lat: 52.52001, lng: 13.40001 })).toBe(
      gridKey({ lat: 52.52002, lng: 13.40002 }),
    );
  });

  it('separates coordinates further apart than the grid', () => {
    expect(gridKey({ lat: 52.52, lng: 13.4 })).not.toBe(gridKey({ lat: 52.523, lng: 13.4 }));
  });
});

describe('confidence', () => {
  it('grows with agreement and shrinks with bad accuracy', () => {
    expect(confidence({ agreeCount: 8, disagreeCount: 0 })).toBeGreaterThan(
      confidence({ agreeCount: 1, disagreeCount: 3 }),
    );
    expect(confidence({ agreeCount: 8, disagreeCount: 0, accuracyM: 80 })).toBeLessThan(
      confidence({ agreeCount: 8, disagreeCount: 0, accuracyM: 5 }),
    );
  });

  it('stays within [0, 1]', () => {
    expect(confidence({ agreeCount: 0, disagreeCount: 0, accuracyM: 500 })).toBeGreaterThanOrEqual(
      0,
    );
    expect(confidence({ agreeCount: 100, disagreeCount: 0 })).toBeLessThanOrEqual(1);
  });
});

describe('passabilityForProfile', () => {
  it('separates profiles on the same curb height', () => {
    const curb = { heightCm: 8, passability: 'PASSABLE' } as const;
    expect(passabilityForProfile('WHEELCHAIR', curb)).toBe('IMPASSABLE');
    expect(passabilityForProfile('DELIVERY_ROBOT', curb)).toBe('DIFFICULT');
    expect(passabilityForProfile('STROLLER', curb)).toBe('DIFFICULT');
    expect(passabilityForProfile('COURIER', curb)).toBe('PASSABLE');
  });

  it('accepts a flush crossing for everyone', () => {
    expect(passabilityForProfile('WHEELCHAIR', { heightCm: 0, passability: 'PASSABLE' })).toBe(
      'PASSABLE',
    );
  });

  it('rejects paths far narrower than the profile needs', () => {
    expect(passabilityForProfile('STROLLER', { widthCm: 40, passability: 'PASSABLE' })).toBe(
      'IMPASSABLE',
    );
    expect(passabilityForProfile('WHEELCHAIR', { widthCm: 80, passability: 'PASSABLE' })).toBe(
      'DIFFICULT',
    );
  });

  it('takes the worst of the reported verdict and both measurements', () => {
    expect(
      passabilityForProfile('COURIER', { heightCm: 0, widthCm: 200, passability: 'IMPASSABLE' }),
    ).toBe('IMPASSABLE');
    // A high curb on a narrow path must not mask the width problem.
    expect(
      passabilityForProfile('WHEELCHAIR', { heightCm: 5, widthCm: 50, passability: 'PASSABLE' }),
    ).toBe('IMPASSABLE');
  });
});
