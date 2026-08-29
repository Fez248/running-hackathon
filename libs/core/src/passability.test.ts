import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSABILITY_RADIUS_M,
  MAX_PASSABILITY_RADIUS_M,
  MAX_PASSABILITY_WAYPOINTS,
  MIN_TRUSTED_WEIGHT,
  STALE_FLOOR,
  aggregatePassability,
  freshness,
  passabilityBatchSchema,
  passabilityQuerySchema,
  proximity,
  type PassabilityObservation,
} from './passability';

const NOW = new Date('2025-06-01T12:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const observation = (over: Partial<PassabilityObservation> = {}): PassabilityObservation => ({
  distanceM: 0,
  passability: 'DIFFICULT',
  confidence: 0.9,
  capturedAt: daysAgo(1),
  ...over,
});

const verdictFor = (
  observations: PassabilityObservation[],
  over: { profile?: 'WHEELCHAIR' | 'COURIER'; radiusM?: number; surveyed?: boolean } = {},
) =>
  aggregatePassability(observations, {
    profile: over.profile ?? 'WHEELCHAIR',
    radiusM: over.radiusM ?? DEFAULT_PASSABILITY_RADIUS_M,
    surveyed: over.surveyed,
    now: NOW,
  });

describe('passability query schemas', () => {
  it('defaults the radius and caps it at the documented maximum', () => {
    const parsed = passabilityQuerySchema.parse({ lat: 52.52, lng: 13.4, profile: 'COURIER' });
    expect(parsed.radiusM).toBe(DEFAULT_PASSABILITY_RADIUS_M);
    expect(
      passabilityQuerySchema.safeParse({
        lat: 52.52,
        lng: 13.4,
        profile: 'COURIER',
        radiusM: MAX_PASSABILITY_RADIUS_M + 1,
      }).success,
    ).toBe(false);
  });

  it('requires a profile: a verdict without one would be meaningless', () => {
    expect(passabilityQuerySchema.safeParse({ lat: 52.52, lng: 13.4 }).success).toBe(false);
  });

  it('caps a batch at one route leg', () => {
    const waypoint = { lat: 52.52, lng: 13.4 };
    expect(
      passabilityBatchSchema.safeParse({
        waypoints: Array.from({ length: MAX_PASSABILITY_WAYPOINTS + 1 }, () => waypoint),
        profile: 'DELIVERY_ROBOT',
      }).success,
    ).toBe(false);
    expect(
      passabilityBatchSchema.parse({ waypoints: [waypoint], profile: 'DELIVERY_ROBOT' }).radiusM,
    ).toBe(DEFAULT_PASSABILITY_RADIUS_M);
  });
});

describe('freshness and proximity', () => {
  it('keeps a recent report at full weight and floors an ancient one', () => {
    expect(freshness(daysAgo(2), NOW)).toBe(1);
    expect(freshness(daysAgo(30), NOW)).toBe(1);
    expect(freshness(daysAgo(105), NOW)).toBeCloseTo(1 - 0.5 * (1 - STALE_FLOOR), 5);
    expect(freshness(daysAgo(1000), NOW)).toBe(STALE_FLOOR);
  });

  it('halves the weight of a report at the edge of the radius', () => {
    expect(proximity(0, 40)).toBe(1);
    expect(proximity(20, 40)).toBe(0.75);
    expect(proximity(40, 40)).toBe(0.5);
    expect(proximity(400, 40)).toBe(0.5);
  });
});

describe('aggregatePassability', () => {
  it('reports an unsurveyed waypoint as an unknown, not as passable', () => {
    const answer = verdictFor([]);
    expect(answer).toMatchObject({
      verdict: 'UNKNOWN',
      confidence: 0,
      sampleSize: 0,
      lastCapturedAt: null,
      surveyed: false,
    });
  });

  it('distinguishes a walked street with nothing flagged from a gap in the map', () => {
    expect(verdictFor([], { surveyed: true })).toMatchObject({
      verdict: 'UNKNOWN',
      sampleSize: 0,
      surveyed: true,
    });
  });

  it('takes the worst trusted observation, not the average', () => {
    const answer = verdictFor([
      observation({ passability: 'PASSABLE' }),
      observation({ passability: 'IMPASSABLE', distanceM: 10 }),
      observation({ passability: 'PASSABLE', distanceM: 20 }),
    ]);
    expect(answer.verdict).toBe('IMPASSABLE');
    expect(answer.sampleSize).toBe(3);
  });

  it('answers per profile: a 5 cm kerb blocks a wheelchair and not a courier', () => {
    const kerb = [observation({ passability: 'PASSABLE', heightCm: 5 })];
    expect(verdictFor(kerb, { profile: 'WHEELCHAIR' }).verdict).toBe('DIFFICULT');
    expect(verdictFor(kerb, { profile: 'COURIER' }).verdict).toBe('PASSABLE');
  });

  it('ignores an observation too weak to trust but still counts it as a sample', () => {
    const answer = verdictFor([
      observation({ passability: 'IMPASSABLE', confidence: 0.2, capturedAt: daysAgo(400) }),
    ]);
    expect(answer.verdict).toBe('UNKNOWN');
    expect(answer.sampleSize).toBe(1);
    expect(answer.surveyed).toBe(true);
    expect(answer.lastCapturedAt).toEqual(daysAgo(400));
  });

  it('trusts a strong old report: pavement does not repair itself', () => {
    const answer = verdictFor([observation({ capturedAt: daysAgo(365) })]);
    expect(answer.verdict).toBe('DIFFICULT');
    expect(answer.confidence).toBeCloseTo(0.9 * STALE_FLOOR, 5);
  });

  it('reports the confidence of the observation behind the verdict', () => {
    const answer = verdictFor([
      observation({ passability: 'IMPASSABLE', confidence: 0.4 }),
      observation({ passability: 'PASSABLE', confidence: 1 }),
    ]);
    // 0.4 confidence x 1 freshness x 1 proximity for the impassable reading.
    // The confident PASSABLE report does not raise it: it is a different claim.
    expect(answer.verdict).toBe('IMPASSABLE');
    expect(answer.confidence).toBeCloseTo(0.4, 5);
  });

  it('never returns a verdict backed by less than the trust floor', () => {
    const answer = verdictFor([observation({ confidence: MIN_TRUSTED_WEIGHT / 2 })]);
    expect(answer.verdict).toBe('UNKNOWN');
    expect(answer.confidence).toBe(0);
  });

  it('reports the most recent capture time across all observations', () => {
    const answer = verdictFor([
      observation({ capturedAt: daysAgo(9) }),
      observation({ capturedAt: daysAgo(2) }),
      observation({ capturedAt: daysAgo(40) }),
    ]);
    expect(answer.lastCapturedAt).toEqual(daysAgo(2));
  });
});
