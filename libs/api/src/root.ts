import { createTRPCRouter } from './trpc';
import { coverageRouter } from './routers/coverage';
import { publicRouter } from './routers/public';
import { reportRouter } from './routers/report';
import { statsRouter } from './routers/stats';
import { traceRouter } from './routers/trace';

export const appRouter = createTRPCRouter({
  report: reportRouter,
  coverage: coverageRouter,
  trace: traceRouter,
  stats: statsRouter,
  public: publicRouter,
});

export type AppRouter = typeof appRouter;
