import { createTRPCRouter } from './trpc';
import { coverageRouter } from './routers/coverage';
import { reportRouter } from './routers/report';
import { reviewRouter } from './routers/review';
import { statsRouter } from './routers/stats';
import { traceRouter } from './routers/trace';

export const appRouter = createTRPCRouter({
  report: reportRouter,
  review: reviewRouter,
  coverage: coverageRouter,
  trace: traceRouter,
  stats: statsRouter,
});

export type AppRouter = typeof appRouter;
