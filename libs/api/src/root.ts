import { createTRPCRouter } from './trpc';
import { reportRouter } from './routers/report';
import { statsRouter } from './routers/stats';
import { traceRouter } from './routers/trace';

export const appRouter = createTRPCRouter({
  report: reportRouter,
  trace: traceRouter,
  stats: statsRouter,
});

export type AppRouter = typeof appRouter;
