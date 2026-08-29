/**
 * Default wiring for the raw-recording route: environment configuration plus
 * the same Prisma ingest the tRPC `scan.ingest` mutation uses, so a recording
 * scanned by the worker lands as exactly the scan a hand-uploaded payload would.
 */

import { prisma } from '@sidewalk/db';
import { ingestScan } from '../routers/scan';
import { scanWorkerConfigFromEnv, type ScanWorkerDeps } from './scan-worker';

export function scanWorkerDeps(): ScanWorkerDeps {
  return {
    config: scanWorkerConfigFromEnv(),
    ingest: (payload) => ingestScan(prisma, payload, null),
  };
}
