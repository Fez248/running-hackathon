import { handleScanWorkerStatus, scanWorkerConfigFromEnv } from '@sidewalk/api';

/** Whether this deployment can scan a raw recording server-side. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return handleScanWorkerStatus(scanWorkerConfigFromEnv());
}
