import { initTRPC, TRPCError } from '@trpc/server';
import { ZodError } from 'zod';
import { transformer } from '@sidewalk/core';
import { prisma } from '@sidewalk/db';

export interface CreateContextOptions {
  headers?: Headers;
}

/**
 * There is no real session layer yet. For local development only, and only when
 * SIDEWALK_DEV_AUTH is explicitly enabled, an `x-sidewalk-user` header may
 * identify the contributor — the header is trivially forgeable, so it is
 * ignored everywhere else and unauthenticated callers stay anonymous.
 */
export async function createTRPCContext(opts: CreateContextOptions = {}) {
  const devAuthEnabled =
    process.env.SIDEWALK_DEV_AUTH === 'true' && process.env.NODE_ENV !== 'production';
  const handle = devAuthEnabled ? (opts.headers?.get('x-sidewalk-user') ?? null) : null;
  const user = handle ? await prisma.user.findUnique({ where: { handle } }) : null;
  return { prisma, user };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<TRPCContext>().create({
  transformer,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;

/** Anonymous crowdsourcing: capture and read do not need an identity. */
export const publicProcedure = t.procedure;

/** Anything that can alter or hide someone else's data needs an identity. */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'This action requires an identified contributor.',
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
