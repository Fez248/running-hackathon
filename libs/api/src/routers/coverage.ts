import {
  DEFAULT_REVEAL_RADIUS_M,
  coverageBoundsSchema,
  coverageRevealSchema,
  fogCellBounds,
  fogCellIndexFromKey,
  fogCellsAlongPath,
  fogClearedAreaM2,
} from '@sidewalk/core';
import { createTRPCRouter, publicProcedure } from '../trpc';

/**
 * Fog of War coverage.
 *
 * `reveal` is called from the client every few seconds with the GPS fixes that
 * passed the accuracy filter; `byBounds` feeds the fog overlay for the viewport.
 * Cells are upserted by their grid key, so replaying the same run is idempotent.
 */
export const coverageRouter = createTRPCRouter({
  /** Revealed cells inside the map viewport. */
  byBounds: publicProcedure
    .input(coverageBoundsSchema)
    .query(async ({ ctx, input }) => {
      const cells = await ctx.prisma.coverageCell.findMany({
        where: {
          lat: { gte: input.minLat, lte: input.maxLat },
          lng: { gte: input.minLng, lte: input.maxLng },
        },
        select: { cellKey: true, lat: true, lng: true, visits: true },
        orderBy: { lastSeenAt: 'desc' },
        take: input.limit,
      });

      return cells.map((cell) => {
        const index = fogCellIndexFromKey(cell.cellKey);
        return {
          ...cell,
          bounds: index ? fogCellBounds(index) : null,
        };
      });
    }),

  /**
   * Reveal the fog along a batch of accepted GPS fixes. Returns the keys that
   * were newly revealed so the client can render them immediately.
   */
  reveal: publicProcedure.input(coverageRevealSchema).mutation(async ({ ctx, input }) => {
    const radiusM = input.revealRadiusM ?? DEFAULT_REVEAL_RADIUS_M;
    const keys = fogCellsAlongPath(input.points, radiusM);

    const existing = await ctx.prisma.coverageCell.findMany({
      where: { cellKey: { in: keys } },
      select: { cellKey: true },
    });
    const known = new Set(existing.map((cell) => cell.cellKey));

    for (const cellKey of keys) {
      const index = fogCellIndexFromKey(cellKey);
      if (!index) continue;
      const bounds = fogCellBounds(index);
      const lat = (bounds.minLat + bounds.maxLat) / 2;
      const lng = (bounds.minLng + bounds.maxLng) / 2;

      await ctx.prisma.coverageCell.upsert({
        where: { cellKey },
        update: {
          visits: { increment: 1 },
          ...(input.traceId ? { traceId: input.traceId } : {}),
        },
        create: {
          cellKey,
          lat,
          lng,
          traceId: input.traceId ?? null,
          userId: ctx.user?.id ?? null,
        },
      });
    }

    const newKeys = keys.filter((key) => !known.has(key));
    return {
      revealed: keys.length,
      newlyRevealed: newKeys.length,
      newKeys,
      newAreaM2: fogClearedAreaM2(newKeys.length),
    };
  }),

  /** Totals for the "explored" readout. */
  summary: publicProcedure.query(async ({ ctx }) => {
    const cells = await ctx.prisma.coverageCell.count();
    return { cells, exploredAreaM2: fogClearedAreaM2(cells) };
  }),
});
