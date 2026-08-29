import { z } from 'zod';
import { coordinateSchema, distanceMeters, profileSchema } from '@sidewalk/core';
import { createTRPCRouter, publicProcedure } from '../trpc';

export const traceRouter = createTRPCRouter({
  /** Upload the path of a run/ride so heatmaps show surveyed coverage. */
  upload: publicProcedure
    .input(
      z.object({
        points: z.array(coordinateSchema).min(2).max(10_000),
        profile: profileSchema.optional(),
        startedAt: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let distanceM = 0;
      for (let i = 1; i < input.points.length; i += 1) {
        const prev = input.points[i - 1];
        const next = input.points[i];
        if (prev && next) distanceM += distanceMeters(prev, next);
      }

      return ctx.prisma.trace.create({
        data: {
          userId: ctx.user?.id ?? null,
          path: JSON.stringify(input.points.map((p) => [p.lat, p.lng])),
          distanceM,
          startedAt: input.startedAt ?? new Date(),
          endedAt: new Date(),
        },
      });
    }),

  /**
   * Open a trace when a run starts, so coverage cells revealed mid-run can be
   * attributed to it instead of waiting for the run to finish.
   */
  start: publicProcedure
    .input(z.object({ profile: profileSchema.optional(), startedAt: z.date().optional() }).default({}))
    .mutation(({ ctx, input }) =>
      ctx.prisma.trace.create({
        data: {
          userId: ctx.user?.id ?? null,
          path: '[]',
          startedAt: input.startedAt ?? new Date(),
        },
      }),
    ),

  /** Close a trace opened by `start` with the path the runner actually covered. */
  finish: publicProcedure
    .input(
      z.object({
        traceId: z.string(),
        points: z.array(coordinateSchema).min(2).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let distanceM = 0;
      for (let i = 1; i < input.points.length; i += 1) {
        const prev = input.points[i - 1];
        const next = input.points[i];
        if (prev && next) distanceM += distanceMeters(prev, next);
      }

      return ctx.prisma.trace.update({
        where: { id: input.traceId },
        data: {
          path: JSON.stringify(input.points.map((p) => [p.lat, p.lng])),
          distanceM,
          endedAt: new Date(),
        },
      });
    }),

  recent: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).default({ limit: 10 }))
    .query(({ ctx, input }) =>
      ctx.prisma.trace.findMany({ orderBy: { startedAt: 'desc' }, take: input.limit }),
    ),
});
