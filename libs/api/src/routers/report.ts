import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  boundsSchema,
  confidence,
  createReportSchema,
  gridKey,
  needsReview,
  isReservedClientReportId,
  parseVoiceReport,
  passabilityForProfile,
  PENDING_REVIEW,
  voiceGate,
  type Passability,
  voiceReportSchema,
  voteSchema,
} from '@sidewalk/core';
import { createTRPCRouter, protectedProcedure, publicProcedure } from '../trpc';

/**
 * `clientReportId` is an upsert key, so a client that guessed an integration's
 * key could occupy the row that integration will later write. Reserved
 * namespaces are therefore refused at the boundary.
 */
function rejectReservedClientReportId(clientReportId: string | undefined): void {
  if (clientReportId && isReservedClientReportId(clientReportId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'clientReportId uses a reserved prefix' });
  }
}

/**
 * `SENSOR` marks an observation as measured by the bridge pipeline, which only
 * the Sensor Logger integration can do (`createSensorReports`). A client saying
 * so would be forging provenance the map presents as automatic.
 */
function rejectServerOwnedSource(source: string): void {
  if (source === 'SENSOR') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'source SENSOR is server-owned' });
  }
}

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

  /**
   * One-tap capture while running/riding. Idempotent on clientReportId.
   *
   * A caller may submit `source: 'VOICE'` here too, so the same server-side
   * review gate applies: a dictation the server cannot corroborate is queued
   * rather than published, whichever procedure it arrives through.
   */
  create: publicProcedure.input(createReportSchema).mutation(async ({ ctx, input }) => {
    const gate = voiceGate(input.source, input.transcript);
    rejectReservedClientReportId(input.clientReportId);
    rejectServerOwnedSource(input.source);
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
      parseConfidence: gate.parseConfidence,
      status: gate.status,
      confidence:
        confidence({ agreeCount: 0, disagreeCount: 0, accuracyM: input.accuracyM }) *
        (gate.parseConfidence ?? 1),
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
   *
   * A parse the server is not confident about is stored `PENDING_REVIEW` rather
   * than published: a guess about a curb is worse than a short delay for the
   * person who has to get past it. `review.queue` picks those up.
   */
  createFromVoice: publicProcedure.input(voiceReportSchema).mutation(async ({ ctx, input }) => {
    rejectReservedClientReportId(input.clientReportId);
    if (input.clientReportId) {
      const existing = await ctx.prisma.report.findUnique({
        where: { clientReportId: input.clientReportId },
      });
      if (existing)
        return {
          report: existing,
          parsed: null,
          ignored: false,
          pendingReview: existing.status === PENDING_REVIEW,
        };
    }

    const parsed = parseVoiceReport(input.transcript, input.recognitionConfidence);
    if (!parsed) return { report: null, parsed: null, ignored: true, pendingReview: false };

    const pendingReview = needsReview(parsed.parseConfidence);

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
      parseConfidence: parsed.parseConfidence,
      status: pendingReview ? PENDING_REVIEW : 'ACTIVE',
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

    return { report, parsed, ignored: false, pendingReview };
  }),

  /** Offline queue flush: send everything captured while out of signal. */
  createMany: publicProcedure
    .input(z.object({ reports: z.array(createReportSchema).min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const ids: string[] = [];
      for (const report of input.reports) {
        const gate = voiceGate(report.source, report.transcript);
        rejectReservedClientReportId(report.clientReportId);
        rejectServerOwnedSource(report.source);
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
          parseConfidence: gate.parseConfidence,
          status: gate.status,
          confidence:
            confidence({
              agreeCount: 0,
              disagreeCount: 0,
              accuracyM: report.accuracyM,
            }) * (gate.parseConfidence ?? 1),
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
    const exists = await ctx.prisma.report.findUnique({
      where: { id: input.reportId },
      select: { id: true },
    });
    if (!exists) throw new TRPCError({ code: 'NOT_FOUND' });

    // One transaction, and the report is re-read inside it: a review decided
    // between the vote arriving and the tally being written must not be undone
    // by a stale `status`, nor its lifted parse penalty reapplied.
    return ctx.prisma.$transaction(async (tx) => {
      await tx.vote.upsert({
        where: { reportId_userId: { reportId: input.reportId, userId: ctx.user.id } },
        update: { agree: input.agree },
        create: { reportId: input.reportId, userId: ctx.user.id, agree: input.agree },
      });

      const [agreeCount, disagreeCount, report] = await Promise.all([
        tx.vote.count({ where: { reportId: input.reportId, agree: true } }),
        tx.vote.count({ where: { reportId: input.reportId, agree: false } }),
        tx.report.findUniqueOrThrow({ where: { id: input.reportId } }),
      ]);
      const buried = disagreeCount >= 3 && disagreeCount > agreeCount * 2;

      return tx.report.update({
        where: { id: input.reportId },
        data: {
          agreeCount,
          disagreeCount,
          // Votes cannot buy away the parser's doubt: until a human has read the
          // transcript, a half-understood dictation stays discounted however
          // many people agree with it. A detected report keeps the detector's
          // own scaling too, so disagreement cannot hand a weak detection the
          // confidence of a human observation.
          confidence:
            confidence({ agreeCount, disagreeCount, accuracyM: report.accuracyM }) *
            (report.reviewedAt ? 1 : (report.parseConfidence ?? 1)) *
            (report.detectorConfidence ?? 1),
          status: buried ? 'REJECTED' : report.status,
        },
      });
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
