import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { gridKey, scanIngestSchema, sensorReportsForScan } from '@sidewalk/core';
import { createTRPCRouter, publicProcedure } from '../trpc';

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
    const existing = await ctx.prisma.surfaceScan.findUnique({
      where: { clientScanId: input.clientScanId },
      include: { reports: { select: { id: true } } },
    });
    if (existing) {
      return {
        scan: { ...existing, reports: undefined },
        reportIds: existing.reports.map((report) => report.id),
        accepted: existing.verdict !== 'unusable',
        problems: input.quality.problems,
      };
    }

    const drafts = sensorReportsForScan(input);
    const accepted = input.quality.verdict !== 'unusable';

    const scan = await ctx.prisma.surfaceScan.create({
      data: {
        clientScanId: input.clientScanId,
        source: input.source,
        format: input.format,
        verdict: input.quality.verdict,
        quality: JSON.stringify(input.quality),
        cadenceSpm: input.cadenceSpm,
        findingCount: input.findings.length,
        reportCount: drafts.length,
        uploadedById: ctx.user?.id ?? null,
      },
    });

    const reportIds: string[] = [];
    for (const draft of drafts) {
      const data = {
        lat: draft.lat,
        lng: draft.lng,
        gridKey: gridKey({ lat: draft.lat, lng: draft.lng }),
        kind: draft.kind,
        passability: draft.passability,
        note: draft.note,
        accuracyM: draft.accuracyM,
        source: draft.source,
        confidence: draft.confidence,
        clientReportId: draft.clientReportId,
        surfaceScanId: scan.id,
        authorId: ctx.user?.id ?? null,
      };
      // Upsert for the same reason report.create does: a retried upload racing
      // the first one must deduplicate instead of hitting the unique index.
      const row = await ctx.prisma.report.upsert({
        where: { clientReportId: draft.clientReportId },
        update: {},
        create: data,
      });
      reportIds.push(row.id);
    }

    return { scan, reportIds, accepted, problems: input.quality.problems };
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
