import {
  aggregatePassability,
  distanceMeters,
  radiusBoxes,
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

/** Reports read for a whole leg while the leg fits in one query. */
const MAX_SCANNED_REPORTS = 2_000;
/** Fog cells read for a whole leg, only to answer "has anyone been here?". */
const MAX_SCANNED_CELLS = 5_000;
/**
 * A row cap on a leg-wide query is only safe while it is not reached: the rows
 * it drops are chosen by the database, not by distance, so a dense stretch of
 * the leg could otherwise starve the waypoints after it. When a leg-wide read
 * comes back full, each waypoint is instead re-read against its own radius —
 * and read to the end, one page at a time, so nothing inside the radius is
 * dropped before the distance filter runs.
 */
const WAYPOINT_PAGE = 1_000;
/**
 * Safety ceiling for those paged reads. A 200 m circle holding this many rows
 * is a data problem or an attack rather than a stretch of pavement, and the
 * request must still terminate.
 */
const MAX_ROWS_PER_WAYPOINT = 20_000;

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
   * leg costs two queries however many waypoints it carries, unless a stretch
   * of it is dense enough to fill one of them.
   */
  passabilityBatch: publicProcedure
    .input(passabilityBatchSchema)
    .query(({ ctx, input }) => verdictsForLeg(ctx.prisma, input)),
});

type Prisma = TRPCContext['prisma'];

const REPORT_COLUMNS = {
  // Exactly the columns a verdict needs — no transcript, author or trace. `id`
  // is the paging cursor and never leaves the server.
  id: true,
  lat: true,
  lng: true,
  status: true,
  passability: true,
  heightCm: true,
  widthCm: true,
  confidence: true,
  createdAt: true,
} as const;

/**
 * Read every row a `where` matches, in pages, up to the safety ceiling. Paging
 * by `id` is stable under concurrent writes, which a cursor on `createdAt` is
 * not.
 */
async function readAll<T extends { id: string }>(
  page: (cursor: string | undefined) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;

  while (rows.length < MAX_ROWS_PER_WAYPOINT) {
    const batch = await page(cursor);
    rows.push(...batch);
    if (batch.length < WAYPOINT_PAGE) break;
    cursor = batch[batch.length - 1]!.id;
  }

  return rows;
}

async function verdictsForLeg(
  prisma: Prisma,
  leg: { waypoints: Coordinate[]; radiusM: number; profile: Profile },
): Promise<(PassabilityVerdict & Coordinate)[]> {
  const { waypoints, radiusM, profile } = leg;
  const neighbourhoods = waypoints.map((waypoint) => coversRadius(waypoint, radiusM));

  const [legReports, legCells] = await Promise.all([
    prisma.report.findMany({
      where: { OR: neighbourhoods.flat() },
      select: REPORT_COLUMNS,
      orderBy: { createdAt: 'desc' },
      take: MAX_SCANNED_REPORTS,
    }),
    prisma.coverageCell.findMany({
      where: { OR: neighbourhoods.flat() },
      select: { id: true, lat: true, lng: true },
      take: MAX_SCANNED_CELLS,
    }),
  ]);

  const reportsComplete = legReports.length < MAX_SCANNED_REPORTS;
  const cellsComplete = legCells.length < MAX_SCANNED_CELLS;

  return Promise.all(
    waypoints.map(async (waypoint, index) => {
      const where = neighbourhoods[index]!;
      const [nearby, cells] = await Promise.all([
        reportsComplete
          ? legReports
          : readAll((cursor) =>
              prisma.report.findMany({
                where: { OR: where },
                select: REPORT_COLUMNS,
                orderBy: { id: 'asc' },
                take: WAYPOINT_PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
              }),
            ),
        cellsComplete
          ? legCells
          : readAll((cursor) =>
              prisma.coverageCell.findMany({
                where: { OR: where },
                select: { id: true, lat: true, lng: true },
                orderBy: { id: 'asc' },
                take: WAYPOINT_PAGE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
              }),
            ),
      ]);

      const inRadius = nearby
        .map((report) => ({
          ...report,
          distanceM: distanceMeters(waypoint, { lat: report.lat, lng: report.lng }),
        }))
        .filter((report) => report.distanceM <= radiusM);
      const observations = observationsFrom(inRadius);
      // Revealed fog is the only way to tell "walked, nothing to flag" apart
      // from "nobody has ever been here", and a fleet routes differently on the
      // two. A resolved or rejected report is not evidence about passability any
      // more, but it is still proof that someone was here.
      const surveyed =
        inRadius.length > 0 || cells.some((cell) => distanceMeters(waypoint, cell) <= radiusM);

      return { ...waypoint, ...aggregatePassability(observations, { profile, radiusM, surveyed }) };
    }),
  );
}

/** `where` fragments whose union covers a waypoint's radius, to be OR-ed. */
function coversRadius(waypoint: Coordinate, radiusM: number) {
  return radiusBoxes(waypoint, radiusM).map((box) => ({
    lat: { gte: box.minLat, lte: box.maxLat },
    lng: { gte: box.minLng, lte: box.maxLng },
  }));
}

interface NearbyReport {
  lat: number;
  lng: number;
  status: string;
  passability: string;
  heightCm: number | null;
  widthCm: number | null;
  confidence: number;
  createdAt: Date;
}

/** The reports inside the radius that still claim something about the street. */
function observationsFrom(
  reports: (NearbyReport & { distanceM: number })[],
): PassabilityObservation[] {
  return reports
    .filter((report) => report.status === 'ACTIVE')
    .map((report) => ({
      distanceM: report.distanceM,
      passability: report.passability as Passability,
      heightCm: report.heightCm,
      widthCm: report.widthCm,
      confidence: report.confidence,
      capturedAt: report.createdAt,
    }));
}
