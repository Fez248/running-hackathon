import {
  aggregatePassability,
  boundsAround,
  distanceMeters,
  passabilityBatchSchema,
  passabilityQuerySchema,
  type Coordinate,
  type Passability,
  type PassabilityObservation,
  type PassabilityVerdict,
  type Profile,
} from '@sidewalk/core';
import { createTRPCRouter, publicProcedure, type TRPCContext } from '../trpc';

/**
 * The fleet-facing read API.
 *
 * A courier dispatcher or a delivery-robot planner needs one thing from this
 * map: "can this profile get through here?" — per waypoint, for a whole route
 * leg, in one call. It gets a verdict and the shape of the evidence (how much,
 * how fresh), never the evidence itself: no transcripts, no contributor
 * identities, no report ids, no traces, and no coordinates it did not send.
 * Every procedure here is a query, so a fleet integration cannot alter the map.
 */

/** Reports read per call, before the radius filter. */
const MAX_SCANNED_REPORTS = 2_000;
/** Fog cells read per call, only to answer "has anyone been here at all?". */
const MAX_SCANNED_CELLS = 5_000;

export const publicRouter = createTRPCRouter({
  /** Verdict for a single waypoint. */
  passability: publicProcedure.input(passabilityQuerySchema).query(async ({ ctx, input }) => {
    const [verdict] = await verdictsForLeg(ctx.prisma, {
      waypoints: [{ lat: input.lat, lng: input.lng }],
      radiusM: input.radiusM,
      profile: input.profile,
    });
    return verdict;
  }),

  /**
   * Verdicts for a route leg, in the order the waypoints were sent. The whole
   * leg costs two queries however many waypoints it carries.
   */
  passabilityBatch: publicProcedure
    .input(passabilityBatchSchema)
    .query(({ ctx, input }) => verdictsForLeg(ctx.prisma, input)),
});

async function verdictsForLeg(
  prisma: TRPCContext['prisma'],
  leg: { waypoints: Coordinate[]; radiusM: number; profile: Profile },
): Promise<(PassabilityVerdict & Coordinate)[]> {
  const { waypoints, radiusM, profile } = leg;
  const box = unionBounds(waypoints, radiusM);
  const within = {
    lat: { gte: box.minLat, lte: box.maxLat },
    lng: { gte: box.minLng, lte: box.maxLng },
  };

  const [reports, cells] = await Promise.all([
    prisma.report.findMany({
      where: { status: 'ACTIVE', ...within },
      // Exactly the columns a verdict needs — no transcript, author or trace.
      select: {
        lat: true,
        lng: true,
        passability: true,
        heightCm: true,
        widthCm: true,
        confidence: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_SCANNED_REPORTS,
    }),
    prisma.coverageCell.findMany({
      where: within,
      select: { lat: true, lng: true },
      take: MAX_SCANNED_CELLS,
    }),
  ]);

  return waypoints.map((waypoint) => {
    const observations = observationsAround(waypoint, reports, radiusM);
    // Revealed fog is the only way to tell "walked, nothing to flag" apart from
    // "nobody has ever been here", and a fleet routes differently on the two.
    const surveyed =
      observations.length > 0 || cells.some((cell) => distanceMeters(waypoint, cell) <= radiusM);

    return { ...waypoint, ...aggregatePassability(observations, { profile, radiusM, surveyed }) };
  });
}

/** Smallest box covering every waypoint's radius, so one query serves the leg. */
function unionBounds(waypoints: Coordinate[], radiusM: number) {
  const boxes = waypoints.map((waypoint) => boundsAround(waypoint, radiusM));
  return {
    minLat: Math.min(...boxes.map((box) => box.minLat)),
    maxLat: Math.max(...boxes.map((box) => box.maxLat)),
    minLng: Math.min(...boxes.map((box) => box.minLng)),
    maxLng: Math.max(...boxes.map((box) => box.maxLng)),
  };
}

interface NearbyReport {
  lat: number;
  lng: number;
  passability: string;
  heightCm: number | null;
  widthCm: number | null;
  confidence: number;
  createdAt: Date;
}

function observationsAround(
  waypoint: Coordinate,
  reports: NearbyReport[],
  radiusM: number,
): PassabilityObservation[] {
  return reports
    .map((report) => ({
      distanceM: distanceMeters(waypoint, { lat: report.lat, lng: report.lng }),
      passability: report.passability as Passability,
      heightCm: report.heightCm,
      widthCm: report.widthCm,
      confidence: report.confidence,
      capturedAt: report.createdAt,
    }))
    .filter((observation) => observation.distanceM <= radiusM);
}
