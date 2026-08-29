import { handleRawScanUpload, scanWorkerDeps } from '@sidewalk/api';

/**
 * Upload a raw phone recording (Sensor Logger .zip or an exported directory)
 * and have a scan worker turn it into map findings. Answers 503 with a reason
 * when this deployment has no worker, which is what makes the panel print the
 * CLI command instead.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleRawScanUpload(request, scanWorkerDeps());
}
