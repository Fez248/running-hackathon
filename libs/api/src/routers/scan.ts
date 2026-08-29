import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  gridKey,
  scanIngestSchema,
  sensorReportsForScan,
  type ScanIngestInput,
} from '@sidewalk/core';
import { createTRPCRouter, publicProcedure, type TRPCContext } from '../trpc';

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
 * Surface scans from `apps/bridge`.
 *
 * A phone IMU + GPS recording is turned into floor imperfections by the Python
 * detector; `ingest` is the seam that turns those findings into `ROUGH_SURFACE`
 * reports on the map. An unusable capture is still recorded — the upload is then
 * auditable rather than silently dropped — but produces no reports, because the
 * quality gate's refusal to trust the recording must survive the trip here.
 *
 * Ingest is idempotent on `clientScanId`: re-uploading the same bridge output
 * resolves to the same scan and the same reports.
 */
export const scanRouter = createTRPCRouter({
  ingest: publicProcedure.input(scanIngestSchema).mutation(async ({ ctx, input }) => {
    const userId = ctx.user?.id ?? null;
    const alreadyThere = await resolveExisting(ctx.prisma, input);
    if (alreadyThere) return alreadyThere;

    try {
      // Scan and reports commit together: a scan row without its reports would
      // be indistinguishable from a completed import and would make every
      // retry a no-op, permanently losing the findings.
      return await ctx.prisma.$transaction(async (tx) => {
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
          },
        });

        const reportIds: string[] = [];
        for (const draft of drafts) {
          // A key in the detector's namespace can only already exist if some
          // other row took it, and adopting that row would attach the scan to a
          // report that is not its finding. Refuse instead: the transaction
          // rolls back, so nothing is left claiming an import that never
          // happened and the upload stays retriable.
          const squatter = await tx.report.findUnique({
            where: { clientReportId: draft.clientReportId },
            select: { id: true },
          });
          if (squatter) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: `Report id ${draft.clientReportId} is already taken; re-upload this scan under a different clientScanId.`,
            });
          }

          const row = await tx.report.create({
            data: {
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
      const winner = await resolveExisting(ctx.prisma, input);
      if (!winner) throw error;
      return winner;
    }
  }),

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
