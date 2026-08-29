import { handleSensorLoggerCompletion, sensorLoggerDeps } from '@sidewalk/api';

/** Bridge worker returns a scan result (or a redacted failure) here. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSensorLoggerCompletion(request, sensorLoggerDeps());
}
