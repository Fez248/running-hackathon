import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  boundsSchema,
  confidence,
  createReportSchema,
  gridKey,
  parseVoiceReport,
  passabilityForProfile,
  type Passability,
  voiceReportSchema,
  voteSchema,
} from '@sidewalk/core';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';

export const reportRouter = createTRPCRouter({
  /** Everything visible in the current map viewport. */
  byBounds: publicProcedure.input(boundsSchema).query(async ({ ctx, input }) => {
    const reports = await ctx.prisma.report.findMany({
      where: {
        status: 'ACTIVE',
        lat: { gte: input.minLat, lte: input.maxLat },
        lng: { gte: input.minLng, lte: input.maxLng },
        ...(input.kinds?.length ? { kind: { in: input.kinds } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });

    return reports.map((report) => ({
      ...report,
      effectivePassability: input.profile
        ? passabilityForProfile(input.profile, {
            heightCm: report.heightCm,
            widthCm: report.widthCm,
            passability: report.passability as Passability,
          })
        : (report.passability as Passability),
    }));
  }),

  byId: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const report = await ctx.prisma.report.findUnique({
      where: { id: input.id },
      include: { author: true, votes: true },
    });
    if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
    return report;
  }),

  /** One-tap capture while running/riding. Idempotent on clientReportId. */
  create: publicProcedure.input(createReportSchema).mutation(async ({ ctx, input }) => {
    const data = {
      lat: input.lat,
      lng: input.lng,
      gridKey: gridKey({ lat: input.lat, lng: input.lng }),
      kind: input.kind,
      passability: input.passability,
      heightCm: input.heightCm ?? null,
      widthCm: input.widthCm ?? null,
      note: input.note ?? null,
      photoUrl: input.photoUrl ?? null,
      accuracyM: input.accuracyM ?? null,
      capturedByProfile: input.capturedByProfile ?? null,
      source: input.source,
      transcript: input.transcript ?? null,
      traceId: input.traceId ?? null,
      clientReportId: input.clientReportId ?? null,
      authorId: ctx.user?.id ?? null,
      confidence: confidence({ agreeCount: 0, disagreeCount: 0, accuracyM: input.accuracyM }),
    };

    // Upsert rather than check-then-create: a retry racing the first attempt
    // would otherwise hit the clientReportId unique constraint instead of
    // deduplicating, which is what createMany already does.
    return input.clientReportId
      ? ctx.prisma.report.upsert({
          where: { clientReportId: input.clientReportId },
          update: {},
          create: data,
        })
      : ctx.prisma.report.create({ data });
  }),

  /**
   * Ambient voice reporting: an utterance dictated while running, geocoded to the
   * GPS fix it was spoken at. The server re-parses the transcript so the stored
   * report never depends on the client's parser version, and returns `null` when
   * the utterance named no sidewalk feature (ambient chatter).
   */
  createFromVoice: publicProcedure.input(voiceReportSchema).mutation(async ({ ctx, input }) => {
    if (input.clientReportId) {
      const existing = await ctx.prisma.report.findUnique({
        where: { clientReportId: input.clientReportId },
      });
      if (existing) return { report: existing, parsed: null, ignored: false };
    }

    const parsed = parseVoiceReport(input.transcript, input.recognitionConfidence);
    if (!parsed) return { report: null, parsed: null, ignored: true };

    const data = {
      lat: input.lat,
      lng: input.lng,
      gridKey: gridKey({ lat: input.lat, lng: input.lng }),
      // Server parse wins: a stored voice report must match its transcript.
      kind: parsed.kind,
      passability: parsed.passability,
      heightCm: parsed.heightCm ?? null,
      widthCm: parsed.widthCm ?? null,
      note: parsed.note,
      accuracyM: input.accuracyM ?? null,
      capturedByProfile: input.capturedByProfile ?? null,
      source: 'VOICE' as const,
      transcript: input.transcript,
      traceId: input.traceId ?? null,
      clientReportId: input.clientReportId ?? null,
      authorId: ctx.user?.id ?? null,
      confidence:
        confidence({ agreeCount: 0, disagreeCount: 0, accuracyM: input.accuracyM }) *
        parsed.parseConfidence,
    };

    const report = input.clientReportId
      ? await ctx.prisma.report.upsert({
          where: { clientReportId: input.clientReportId },
          update: {},
          create: data,
        })
      : await ctx.prisma.report.create({ data });

    return { report, parsed, ignored: false };
  }),

  /** Offline queue flush: send everything captured while out of signal. */
  createMany: publicProcedure
    .input(z.object({ reports: z.array(createReportSchema).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const ids: string[] = [];
      for (const report of input.reports) {
        const data = {
          lat: report.lat,
          lng: report.lng,
          gridKey: gridKey({ lat: report.lat, lng: report.lng }),
          kind: report.kind,
          passability: report.passability,
          heightCm: report.heightCm ?? null,
          widthCm: report.widthCm ?? null,
          note: report.note ?? null,
          photoUrl: report.photoUrl ?? null,
          accuracyM: report.accuracyM ?? null,
          capturedByProfile: report.capturedByProfile ?? null,
          source: report.source,
          transcript: report.transcript ?? null,
          traceId: report.traceId ?? null,
          clientReportId: report.clientReportId ?? null,
          authorId: ctx.user?.id ?? null,
          confidence: confidence({
            agreeCount: 0,
            disagreeCount: 0,
            accuracyM: report.accuracyM,
          }),
        };

        const row = report.clientReportId
          ? await ctx.prisma.report.upsert({
              where: { clientReportId: report.clientReportId },
              update: {},
              create: data,
            })
          : await ctx.prisma.report.create({ data });
        ids.push(row.id);
      }
      return { ids, count: ids.length };
    }),

  /**
   * Confirm or dispute someone else's report. Requires an identity: one vote
   * per contributor per report, otherwise a single caller could bury a report
   * by repeating the call.
   */
  vote: protectedProcedure.input(voteSchema).mutation(async ({ ctx, input }) => {
    const report = await ctx.prisma.report.findUnique({ where: { id: input.reportId } });
    if (!report) throw new TRPCError({ code: 'NOT_FOUND' });

    await ctx.prisma.vote.upsert({
      where: { reportId_userId: { reportId: input.reportId, userId: ctx.user.id } },
      update: { agree: input.agree },
      create: { reportId: input.reportId, userId: ctx.user.id, agree: input.agree },
    });

    const [agreeCount, disagreeCount] = await Promise.all([
      ctx.prisma.vote.count({ where: { reportId: input.reportId, agree: true } }),
      ctx.prisma.vote.count({ where: { reportId: input.reportId, agree: false } }),
    ]);

    return ctx.prisma.report.update({
      where: { id: input.reportId },
      data: {
        agreeCount,
        disagreeCount,
        confidence: confidence({ agreeCount, disagreeCount, accuracyM: report.accuracyM }),
        status: disagreeCount >= 3 && disagreeCount > agreeCount * 2 ? 'REJECTED' : report.status,
      },
    });
  }),

  /**
   * Mark a feature fixed: roadworks removed, ramp built, van driven away.
   * Hiding a report from the map is destructive, so only its author may do it.
   */
  resolve: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const report = await ctx.prisma.report.findUnique({ where: { id: input.id } });
      if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
      if (report.authorId && report.authorId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the contributor who filed a report can resolve it.',
        });
      }

      return ctx.prisma.report.update({
        where: { id: input.id },
        data: { status: 'RESOLVED' },
      });
    }),
});
