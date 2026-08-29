import { describe, expect, it } from 'vitest';
import { boundsAround, distanceMeters, gridKey } from './geo';
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

describe('gridKey', () => {
  it('clusters nearby coordinates', () => {
    expect(gridKey({ lat: 52.52001, lng: 13.40001 })).toBe(gridKey({ lat: 52.52002, lng: 13.40002 }));
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
});

describe('passabilityForProfile', () => {
  it('rejects a 15 cm curb for wheelchairs but allows a flush crossing', () => {
    expect(
      passabilityForProfile('WHEELCHAIR', { heightCm: 15, passability: 'PASSABLE' }),
    ).toBe('IMPASSABLE');
    expect(passabilityForProfile('WHEELCHAIR', { heightCm: 0, passability: 'PASSABLE' })).toBe(
      'PASSABLE',
    );
  });

  it('rejects paths narrower than the profile needs', () => {
    expect(passabilityForProfile('STROLLER', { widthCm: 40, passability: 'PASSABLE' })).toBe(
      'IMPASSABLE',
    );
  });
});
