import { z } from 'zod';
import {
  latitudeSchema,
  longitudeSchema,
  profileSchema,
  type Passability,
  type Profile,
} from './obstacles';
import { passabilityForProfile } from './scoring';

/**
 * Fleet passability: "can this profile get through here right now?"
 *
 * A courier dispatcher or a delivery-robot planner does not want the map's
 * reports — it wants one verdict per waypoint it is about to route through, and
 * it must be able to tell "nothing blocks this" apart from "nobody has ever
 * looked". Aggregation lives here, free of server imports, so the rule is
 * testable and identical wherever it runs.
 *
 * Deliberately absent from the answer: transcripts, contributor identity, raw
 * traces, report ids and coordinates. A routing client gets a verdict, not the
 * movements of the people who produced it.
 */

/** A waypoint's neighbourhood, capped so one call cannot scan a city. */
export const MAX_PASSABILITY_RADIUS_M = 200;
export const DEFAULT_PASSABILITY_RADIUS_M = 40;
/** Waypoints per batch call, i.e. one route leg at a time. */
export const MAX_PASSABILITY_WAYPOINTS = 50;

/**
 * Observations weaker than this are read as noise: a single unconfirmed report
 * with poor GPS must not close a street for an entire fleet.
 */
export const MIN_TRUSTED_WEIGHT = 0.25;
/** Reports stay at full weight for this long, then decay. */
export const FRESH_FOR_DAYS = 30;
/** ...reaching the floor weight this long after capture. */
export const STALE_AFTER_DAYS = 180;
/**
 * Weight an ancient report keeps. Pavement rarely repairs itself, so a
 * well-confirmed old report must stay above `MIN_TRUSTED_WEIGHT` on its own.
 */
export const STALE_FLOOR = 0.35;

export const passabilityQuerySchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
  radiusM: z
    .number()
    .min(1)
    .max(MAX_PASSABILITY_RADIUS_M)
    .default(DEFAULT_PASSABILITY_RADIUS_M),
  profile: profileSchema,
});
export type PassabilityQuery = z.infer<typeof passabilityQuerySchema>;

export const passabilityBatchSchema = z.object({
  waypoints: z
    .array(z.object({ lat: latitudeSchema, lng: longitudeSchema }))
    .min(1)
    .max(MAX_PASSABILITY_WAYPOINTS),
  radiusM: z
    .number()
    .min(1)
    .max(MAX_PASSABILITY_RADIUS_M)
    .default(DEFAULT_PASSABILITY_RADIUS_M),
  profile: profileSchema,
});
export type PassabilityBatchQuery = z.infer<typeof passabilityBatchSchema>;

/** The subset of a report the verdict is allowed to see. */
export interface PassabilityObservation {
  /** Metres from the queried waypoint. */
  distanceM: number;
  passability: Passability;
  heightCm?: number | null;
  widthCm?: number | null;
  /** Crowd/GPS confidence of the report itself, in [0, 1]. */
  confidence: number;
  capturedAt: Date;
}

export interface PassabilityVerdict {
  verdict: Passability;
  /** Confidence in `verdict`, in [0, 1]; 0 when nothing supports a call. */
  confidence: number;
  /** Observations inside the radius, whatever their weight. */
  sampleSize: number;
  lastCapturedAt: Date | null;
  /**
   * Whether anyone has been here at all — either a report or revealed fog.
   * `UNKNOWN` with `surveyed: false` is a gap in the map; `UNKNOWN` with
   * `surveyed: true` means the street was walked and nothing was flagged.
   */
  surveyed: boolean;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const DAY_MS = 86_400_000;

/** Age decay: full weight while fresh, then linear down to `STALE_FLOOR`. */
export function freshness(capturedAt: Date, now: Date): number {
  const ageDays = (now.getTime() - capturedAt.getTime()) / DAY_MS;
  if (ageDays <= FRESH_FOR_DAYS) return 1;
  const span = STALE_AFTER_DAYS - FRESH_FOR_DAYS;
  const decayed = 1 - ((ageDays - FRESH_FOR_DAYS) / span) * (1 - STALE_FLOOR);
  return clamp01(Math.max(STALE_FLOOR, decayed));
}

/**
 * Distance decay: a report on the waypoint counts fully, one at the edge of the
 * radius counts half, because it may well describe the next feature along.
 */
export function proximity(distanceM: number, radiusM: number): number {
  if (radiusM <= 0) return 0;
  return clamp01(1 - 0.5 * clamp01(distanceM / radiusM));
}

const SEVERITY: Record<Passability, number> = {
  PASSABLE: 0,
  UNKNOWN: 1,
  DIFFICULT: 2,
  IMPASSABLE: 3,
};

/**
 * Worst trusted observation wins, per profile: a kerb that is a nuisance to a
 * courier is a wall to a wheelchair, and the fleet needs the pessimistic answer.
 * Untrusted observations still count towards `sampleSize` — the data exists —
 * but never towards the verdict.
 */
export function aggregatePassability(
  observations: PassabilityObservation[],
  options: { profile: Profile; radiusM: number; surveyed?: boolean; now?: Date },
): PassabilityVerdict {
  const now = options.now ?? new Date();
  const lastCapturedAt = observations.reduce<Date | null>(
    (latest, observation) =>
      !latest || observation.capturedAt > latest ? observation.capturedAt : latest,
    null,
  );

  const trusted = observations
    .map((observation) => ({
      effective: passabilityForProfile(options.profile, {
        heightCm: observation.heightCm,
        widthCm: observation.widthCm,
        passability: observation.passability,
      }),
      weight:
        clamp01(observation.confidence) *
        freshness(observation.capturedAt, now) *
        proximity(observation.distanceM, options.radiusM),
    }))
    .filter((scored) => scored.weight >= MIN_TRUSTED_WEIGHT);

  // `UNKNOWN` is not a mild verdict, it is the absence of one, so it neither
  // seeds nor competes in the severity fold: a report someone filed without
  // judging passability must not bury a confirmed `PASSABLE` next to it. Such a
  // report still decides the verdict once its measurements make it `DIFFICULT`
  // or `IMPASSABLE` for the profile, which is what `effective` accounts for.
  const decisive = trusted.filter((scored) => scored.effective !== 'UNKNOWN');
  const verdict: Passability = decisive.length
    ? decisive.reduce<Passability>(
        (worst, scored) =>
          SEVERITY[scored.effective] > SEVERITY[worst] ? scored.effective : worst,
        decisive[0]!.effective,
      )
    : 'UNKNOWN';
  const confidence = decisive.reduce(
    (best, scored) => (scored.effective === verdict ? Math.max(best, scored.weight) : best),
    0,
  );

  return {
    verdict,
    confidence,
    sampleSize: observations.length,
    lastCapturedAt,
    surveyed: options.surveyed ?? observations.length > 0,
  };
}
