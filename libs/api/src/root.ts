import { createTRPCRouter } from './trpc';
import { coverageRouter } from './routers/coverage';
import { publicRouter } from './routers/public';
import { reportRouter } from './routers/report';
import { reviewRouter } from './routers/review';
import { scanRouter } from './routers/scan';
import { statsRouter } from './routers/stats';
import { traceRouter } from './routers/trace';

export const appRouter = createTRPCRouter({
  report: reportRouter,
  review: reviewRouter,
  coverage: coverageRouter,
  trace: traceRouter,
  scan: scanRouter,
  stats: statsRouter,
  public: publicRouter,
});

export type AppRouter = typeof appRouter;
