import { handleSensorLoggerWebhook, sensorLoggerDeps } from '@sidewalk/api';

/**
 * Sensor Logger Studies webhook target. Configure this URL in the Study editor
 * (Webhooks -> Notify or Notify & Respond); see docs/SENSOR_LOGGER_SYNC.md.
 *
 * Node runtime: the handler talks to Prisma. `force-dynamic` because a webhook
 * must never be served from a cache.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  return handleSensorLoggerWebhook(request, sensorLoggerDeps());
}
