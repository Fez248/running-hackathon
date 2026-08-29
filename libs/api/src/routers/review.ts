import { TRPCError } from '@trpc/server';
import {
  confidence,
  parseVoiceReport,
  PENDING_REVIEW,
  reviewDecisionSchema,
  reviewedFields,
  reviewQueueSchema,
} from '@sidewalk/core';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * The voice quality loop.
 *
 * A dictated report the parser only half understood is held in
 * `PENDING_REVIEW` — off the public map — until a contributor with an identity
 * judges it. The queue hands a reviewer exactly what is needed to judge one:
 * the transcript, what the parser made of it, and where it was spoken. Deciding
 * requires an identity, since a queue anyone can empty is not a quality gate.
 */
export const reviewRouter = createTRPCRouter({
  /** Queued dictated reports, oldest first — the runner has waited longest. */
  queue: protectedProcedure.input(reviewQueueSchema).query(async ({ ctx, input }) => {
    const cursor = input.after
      ? await ctx.prisma.report.findUnique({
          where: { id: input.after },
          select: { id: true, createdAt: true },
        })
      : null;

    const reports = await ctx.prisma.report.findMany({
      where: {
        status: PENDING_REVIEW,
        // `createdAt` alone is not unique — a run can queue two utterances in the
        // same millisecond — so the cursor is (createdAt, id) and the page
        // boundary keeps the timestamp's remaining peers eligible.
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: {
        id: true,
        lat: true,
        lng: true,
        kind: true,
        passability: true,
        heightCm: true,
        widthCm: true,
        note: true,
        transcript: true,
        parseConfidence: true,
        accuracyM: true,
        capturedByProfile: true,
        createdAt: true,
      },
    });

    return {
      reports: reports.map((report) => ({
        ...report,
        // What the parser latched onto, so a reviewer can see why it read the
        // transcript this way instead of guessing.
        matchedPhrase: report.transcript
          ? (parseVoiceReport(report.transcript)?.matchedPhrase ?? null)
          : null,
      })),
      nextCursor: reports.length === input.limit ? (reports[reports.length - 1]?.id ?? null) : null,
    };
  }),

  /** How big the backlog is, for a badge on the review panel. */
  pendingCount: protectedProcedure.query(({ ctx }) =>
    ctx.prisma.report.count({ where: { status: PENDING_REVIEW } }),
  ),

  /**
   * Approve, correct or reject one queued report. Idempotent by status: a
   * report two reviewers open at once is only decided by the first, so the
   * second does not silently overwrite a correction with an approval.
   */
  decide: protectedProcedure.input(reviewDecisionSchema).mutation(async ({ ctx, input }) => {
    const report = await ctx.prisma.report.findUnique({ where: { id: input.reportId } });
    if (!report) throw new TRPCError({ code: 'NOT_FOUND' });
    if (report.authorId && report.authorId === ctx.user.id) {
      // Reviewing one's own dictation is not a second opinion, which is the
      // whole point of the queue.
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'A dictated report has to be reviewed by someone other than its author.',
      });
    }
    if (report.status !== PENDING_REVIEW) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This report has already been reviewed.',
      });
    }

    const fields = reviewedFields(
      input,
      confidence({
        agreeCount: report.agreeCount,
        disagreeCount: report.disagreeCount,
        accuracyM: report.accuracyM,
      }),
    );

    const updated = await ctx.prisma.report.updateMany({
      where: { id: report.id, status: PENDING_REVIEW },
      data: {
        ...fields,
        reviewedAt: new Date(),
        ...(input.action === 'reject' ? { reviewNote: input.reason ?? null } : {}),
      },
    });
    if (!updated.count) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'This report has already been reviewed.',
      });
    }

    return { id: report.id, status: fields.status };
  }),
});
