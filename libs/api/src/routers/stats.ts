import { createTRPCRouter, publicProcedure } from '../trpc';

export const statsRouter = createTRPCRouter({
  /** Numbers for the demo dashboard / contributor leaderboard. */
  summary: publicProcedure.query(async ({ ctx }) => {
    const [reports, byKind, traces, topContributors] = await Promise.all([
      ctx.prisma.report.count({ where: { status: 'ACTIVE' } }),
      ctx.prisma.report.groupBy({ by: ['kind'], _count: { _all: true } }),
      ctx.prisma.trace.aggregate({ _count: { _all: true }, _sum: { distanceM: true } }),
      ctx.prisma.user.findMany({ orderBy: { points: 'desc' }, take: 5 }),
    ]);

    return {
      reports,
      byKind: byKind.map((row) => ({ kind: row.kind, count: row._count._all })),
      traceCount: traces._count._all,
      surveyedMeters: traces._sum.distanceM ?? 0,
      topContributors: topContributors.map((u) => ({
        handle: u.handle,
        displayName: u.displayName,
        points: u.points,
      })),
    };
  }),
});
