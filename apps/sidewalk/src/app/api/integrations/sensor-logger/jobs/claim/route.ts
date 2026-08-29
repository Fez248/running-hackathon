import { handleSensorLoggerClaim, sensorLoggerDeps } from '@sidewalk/api';

/** Bridge worker leases pending uploads here (worker bearer token). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSensorLoggerClaim(request, sensorLoggerDeps());
}
