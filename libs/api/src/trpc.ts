import { initTRPC } from '@trpc/server';
import { ZodError } from 'zod';
import { transformer } from '@sidewalk/core';
import { prisma } from '@sidewalk/db';

export interface CreateContextOptions {
  headers?: Headers;
}

/**
 * Hackathon auth: an optional `x-sidewalk-user` header identifies the
 * contributor. Replace with a real session before anything ships.
 */
export async function createTRPCContext(opts: CreateContextOptions = {}) {
  const handle = opts.headers?.get('x-sidewalk-user') ?? null;
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
export const publicProcedure = t.procedure;
