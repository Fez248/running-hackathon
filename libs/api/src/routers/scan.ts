import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  gridKey,
  scanIngestSchema,
  sensorReportsForScan,
  type ScanIngestInput,
} from '@sidewalk/core';
import { createTRPCRouter, publicProcedure, type TRPCContext } from '../trpc';

/**
 * Provenance columns for a scan row. Spread into the create, so a payload from
 * a bridge build without the provenance block still ingests — as a scan whose
 * capture settings are honestly unknown rather than as a rejection.
 */
function provenanceColumns(provenance: ScanIngestInput['provenance']) {
  return {
    recorderApp: provenance?.recorderApp ?? null,
    recorderVersion: provenance?.recorderVersion ?? null,
    deviceModel: provenance?.deviceModel ?? null,
    platform: provenance?.platform ?? null,
    requestedFsHz: provenance?.requestedFsHz ?? null,
    measuredFsHz: provenance?.measuredFsHz ?? null,
    unitScale: provenance?.unitScale ?? null,
    detectorThreshold: provenance?.detectorThreshold ?? null,
  };
}

/** Prisma's unique-constraint failure. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

/**
 * The answer for a scan that has already been imported, so an upload repeated
 * — by a retry, a second tab or a concurrent request — resolves to the same
 * scan and the same reports instead of creating or failing anything.
 */
async function resolveExisting(prisma: TRPCContext['prisma'], input: ScanIngestInput) {
  const existing = await prisma.surfaceScan.findUnique({
    where: { clientScanId: input.clientScanId },
    include: { reports: { select: { id: true } } },
  });
  if (!existing) return null;

  const { reports, ...scan } = existing;
  return {
    scan,
    reportIds: reports.map((report) => report.id),
    accepted: existing.verdict !== 'unusable',
    problems: input.quality.problems,
  };
}

/**
 * Turn a bridge scan payload into a scan row and its `ROUGH_SURFACE` reports.
 *
 * An unusable capture is still recorded — the upload is then auditable rather
 * than silently dropped — but produces no reports, because the quality gate's
 * refusal to trust the recording must survive the trip here. Idempotent on
 * `clientScanId`: re-uploading the same bridge output resolves to the same scan
 * and the same reports.
 *
 * Exported because a payload reaches the map through two doors: this router,
 * and the raw-export route that has a scan worker produce the payload first.
 */
export async function ingestScan(
  prisma: TRPCContext['prisma'],
  input: ScanIngestInput,
  userId: string | null,
) {
  const alreadyThere = await resolveExisting(prisma, input);
  if (alreadyThere) return alreadyThere;

  try {
    // Scan and reports commit together: a scan row without its reports would
    // be indistinguishable from a completed import and would make every
    // retry a no-op, permanently losing the findings.
    return await prisma.$transaction(async (tx) => {
      const drafts = sensorReportsForScan(input);
      const scan = await tx.surfaceScan.create({
        data: {
          clientScanId: input.clientScanId,
          source: input.source,
          format: input.format,
          verdict: input.quality.verdict,
          quality: JSON.stringify(input.quality),
          cadenceSpm: input.cadenceSpm,
          findingCount: input.findings.length,
          reportCount: drafts.length,
          uploadedById: userId,
          ...provenanceColumns(input.provenance),
        },
      });

      const reportIds: string[] = [];
      for (const draft of drafts) {
        // Upsert for the same reason report.create does: a retried upload
        // must deduplicate instead of hitting the unique index.
        const row = await tx.report.upsert({
          where: { clientReportId: draft.clientReportId },
          update: {},
          create: {
            lat: draft.lat,
            lng: draft.lng,
            gridKey: gridKey({ lat: draft.lat, lng: draft.lng }),
            kind: draft.kind,
            passability: draft.passability,
            note: draft.note,
            accuracyM: draft.accuracyM,
            source: draft.source,
            confidence: draft.confidence,
            detectorConfidence: draft.detectorConfidence,
            clientReportId: draft.clientReportId,
            surfaceScanId: scan.id,
            authorId: userId,
          },
        });
        reportIds.push(row.id);
      }

      return {
        scan,
        reportIds,
        accepted: input.quality.verdict !== 'unusable',
        problems: input.quality.problems,
      };
    });
  } catch (error) {
    // Two uploads of one scan can both pass the lookup above; the loser of
    // the unique index is still an idempotent upload, not a failure.
    if (!isUniqueViolation(error)) throw error;
    const winner = await resolveExisting(prisma, input);
    if (!winner) throw error;
    return winner;
  }
}

/**
 * Surface scans from `apps/bridge`.
 *
 * A phone IMU + GPS recording is turned into floor imperfections by the Python
 * detector; `ingest` is the seam that turns those findings into `ROUGH_SURFACE`
 * reports on the map, carrying the capture settings that produced them so a
 * finding can be argued with rather than only believed.
 */
export const scanRouter = createTRPCRouter({
  ingest: publicProcedure
    .input(scanIngestSchema)
    .mutation(({ ctx, input }) => ingestScan(ctx.prisma, input, ctx.user?.id ?? null)),

  /** Uploaded scans, newest first, for the scan history panel. */
  recent: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).default({ limit: 10 }))
    .query(async ({ ctx, input }) => {
      const scans = await ctx.prisma.surfaceScan.findMany({
        orderBy: { createdAt: 'desc' },
        take: input.limit,
      });
      return scans.map((scan) => ({ ...scan, quality: JSON.parse(scan.quality) as unknown }));
    }),

  byId: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const scan = await ctx.prisma.surfaceScan.findUnique({
      where: { id: input.id },
      include: { reports: { orderBy: { createdAt: 'asc' } } },
    });
    if (!scan) throw new TRPCError({ code: 'NOT_FOUND' });
    return { ...scan, quality: JSON.parse(scan.quality) as unknown };
  }),
});
