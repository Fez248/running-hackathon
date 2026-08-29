import { describe, expect, it } from 'vitest';
import { createGpsFilter, gpsQuality, smoothFix, smoothingWeight } from './gps';

const START = { lat: 52.5208, lng: 13.4095, accuracyM: 6, timestamp: 1_000 };

describe('createGpsFilter', () => {
  it('accepts the first usable fix', () => {
    const filter = createGpsFilter();
    expect(filter.push(START)).toMatchObject({ accepted: true });
    expect(filter.last).toMatchObject({ lat: START.lat, lng: START.lng });
  });

  it('drops fixes with poor reported accuracy', () => {
    const filter = createGpsFilter();
    expect(filter.push({ ...START, accuracyM: 120 })).toEqual({
      accepted: false,
      reason: 'inaccurate',
    });
    expect(filter.last).toBeNull();
  });

  it('drops jitter while standing still', () => {
    const filter = createGpsFilter();
    filter.push(START);
    expect(filter.push({ ...START, lat: START.lat + 0.000005, timestamp: 2_000 })).toEqual({
      accepted: false,
      reason: 'too-close',
    });
  });

  it('drops teleports between cell-tower fixes', () => {
    const filter = createGpsFilter();
    filter.push(START);
    expect(filter.push({ ...START, lat: START.lat + 0.01, timestamp: 2_000 })).toEqual({
      accepted: false,
      reason: 'implausible-speed',
    });
  });

  it('accumulates track distance over a plausible run', () => {
    const filter = createGpsFilter();
    filter.push(START);
    for (let i = 1; i <= 5; i += 1) {
      filter.push({ ...START, lat: START.lat + i * 0.00009, timestamp: 1_000 + i * 2_000 });
    }
    expect(filter.trackDistanceM).toBeGreaterThan(10);
    expect(filter.trackDistanceM).toBeLessThan(60);
  });

  it('keeps accepting steady movement on coarse fixes', () => {
    const filter = createGpsFilter();
    // 5 m/s at 25 m accuracy: the smoothed position lags ~19 m behind, so
    // judging speed against it would report a teleport on every fix.
    const stepDeg = 0.00009;
    filter.push({ ...START, accuracyM: 25 });
    for (let i = 1; i <= 20; i += 1) {
      expect(
        filter.push({
          ...START,
          accuracyM: 25,
          lat: START.lat + i * stepDeg,
          timestamp: 1_000 + i * 2_000,
        }),
      ).toMatchObject({ accepted: true });
    }
  });

  it('resets cleanly between runs', () => {
    const filter = createGpsFilter();
    filter.push(START);
    filter.reset();
    expect(filter.last).toBeNull();
    expect(filter.trackDistanceM).toBe(0);
  });
});

describe('smoothing', () => {
  it('trusts precise fixes more than loose ones', () => {
    expect(smoothingWeight(4)).toBeGreaterThan(smoothingWeight(25));
  });

  it('moves the smoothed position towards the new fix', () => {
    const next = { lat: START.lat + 0.0002, lng: START.lng, accuracyM: 25, timestamp: 3_000 };
    const smoothed = smoothFix(START, next);
    expect(smoothed.lat).toBeGreaterThan(START.lat);
    expect(smoothed.lat).toBeLessThan(next.lat);
  });
});

describe('gpsQuality', () => {
  it('labels accuracy bands', () => {
    expect(gpsQuality(5)).toBe('precise');
    expect(gpsQuality(20)).toBe('coarse');
    expect(gpsQuality(90)).toBe('poor');
    expect(gpsQuality(null)).toBe('coarse');
  });
});
