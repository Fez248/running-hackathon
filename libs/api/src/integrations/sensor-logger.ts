/**
 * Sensor Logger Studies sync — HTTP handlers.
 *
 * Three endpoints, all framework-agnostic (`Request` in, `Response` out) so the
 * Next route handlers in `apps/sidewalk` stay one-liners and these can be tested
 * without a server or a database:
 *
 * - `POST /api/integrations/sensor-logger/webhook` — called by Sensor Logger Cloud
 *   once per uploaded recording; authenticates the Study secret, deduplicates by
 *   `studyId` + `uploadId`, and records the upload as PENDING work.
 * - `POST /api/integrations/sensor-logger/jobs/claim` — the bridge worker leases
 *   pending uploads (worker bearer token).
 * - `POST /api/integrations/sensor-logger/jobs/complete` — the worker returns a
 *   `bridge scan` result, which becomes ROUGH_SURFACE reports, or a redacted error.
 *
 * The recording is downloaded from the Study API by the worker, which holds its
 * own copy of the Study secret; the secret in the webhook body is used only to
 * authenticate the call and is never stored, logged or echoed back.
 *
 * Contract, configuration and rationale: docs/SENSOR_LOGGER_SYNC.md
 */

import {
  authorizeWebhook,
  redactWebhookPayload,
  scanToReports,
  sensorLoggerClaimSchema,
  sensorLoggerCompletionSchema,
  sensorLoggerWebhookSchema,
  secretCodeMatches,
  uploadKey,
  type CreateReportInput,
  type SensorLoggerJobStatus,
} from '@sidewalk/core';

/** Webhook bodies are three short strings; anything larger is not one. */
export const MAX_WEBHOOK_BODY_BYTES = 8 * 1024;
/** A scan result carries up to 500 findings. */
export const MAX_COMPLETION_BODY_BYTES = 512 * 1024;
/** A lease older than this is assumed dead (worker crashed mid-download). */
export const DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60 * 1000;
/** Give up after this many claims so one bad recording cannot spin forever. */
export const DEFAULT_MAX_ATTEMPTS = 5;

export interface SensorLoggerConfig {
  /** Study secret code (`SENSOR_LOGGER_SECRET_CODE`). Absent = integration disabled. */
  secretCode: string | null;
  /** Optional study allowlist (`SENSOR_LOGGER_STUDY_IDS`, comma separated). */
  studyIds: string[];
  /** Bearer token the bridge worker authenticates with (`SENSOR_LOGGER_WORKER_TOKEN`). */
  workerToken: string | null;
  claimTimeoutMs: number;
  maxAttempts: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function sensorLoggerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): SensorLoggerConfig {
  return {
    secretCode: env.SENSOR_LOGGER_SECRET_CODE?.trim() || null,
    studyIds: (env.SENSOR_LOGGER_STUDY_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
    workerToken: env.SENSOR_LOGGER_WORKER_TOKEN?.trim() || null,
    claimTimeoutMs: positiveInt(env.SENSOR_LOGGER_CLAIM_TIMEOUT_MS, DEFAULT_CLAIM_TIMEOUT_MS),
    maxAttempts: positiveInt(env.SENSOR_LOGGER_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
  };
}

export interface EnqueueResult {
  created: boolean;
  status: SensorLoggerJobStatus;
}

export interface ClaimedUpload {
  studyId: string;
  uploadId: string;
  attempts: number;
}

export interface CompletionRecord {
  studyId: string;
  uploadId: string;
  status: 'DONE' | 'FAILED';
  bytes?: number;
  findingCount?: number;
  reportCount?: number;
  quality?: string;
  error?: string;
}

/**
 * Persistence port. The Prisma implementation is `prismaSensorLoggerStore`;
 * tests use an in-memory fake, and a future queue (Vercel Queues, SQS) can be
 * dropped in here without touching the handlers.
 */
export interface SensorLoggerUploadStore {
  /** Record an upload as pending work. Idempotent on (studyId, uploadId). */
  enqueue(upload: { studyId: string; uploadId: string }): Promise<EnqueueResult>;
  /** Lease up to `limit` uploads, reclaiming leases older than `staleBefore`. */
  claim(options: { limit: number; staleBefore: Date; maxAttempts: number }): Promise<ClaimedUpload[]>;
  /** Whether this upload was ever webhooked. Checked before a scan touches the map. */
  isKnown(upload: { studyId: string; uploadId: string }): Promise<boolean>;
  /** Close out a leased upload. `false` when no such upload is known. */
  complete(record: CompletionRecord): Promise<boolean>;
}

export interface SensorLoggerDeps {
  store: SensorLoggerUploadStore;
  /** Persist mapped reports; returns how many rows the map now has for them. */
  createReports(reports: CreateReportInput[]): Promise<number>;
  config: SensorLoggerConfig;
  now?: () => Date;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Read a bounded body. `Content-Length` is checked first so an oversized upload
 * is refused before it is buffered; the decoded length is checked as well
 * because the header is advisory.
 */
async function readBoundedText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: json({ error: 'payload-too-large' }, 413) };
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return { ok: false, response: json({ error: 'payload-too-large' }, 413) };
  }
  return { ok: true, text };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Sensor Logger Cloud calls the webhook exactly once per uploaded recording, so
 * a rejected call loses the recording. Everything that is *our* fault therefore
 * answers 5xx (Sensor Logger's connectivity test surfaces the failure), while a
 * bad credential or an unparseable body answers 4xx.
 */
export async function handleSensorLoggerWebhook(
  request: Request,
  deps: SensorLoggerDeps,
): Promise<Response> {
  const body = await readBoundedText(request, MAX_WEBHOOK_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsedJson = parseJson(body.text);
  if (!parsedJson.ok) return json({ error: 'invalid-json' }, 400);

  const parsed = sensorLoggerWebhookSchema.safeParse(parsedJson.value);
  // The unvalidated body may contain a secret, so nothing from it is echoed.
  if (!parsed.success) return json({ error: 'invalid-payload' }, 400);

  const auth = authorizeWebhook(parsed.data, {
    expectedSecretCode: deps.config.secretCode,
    allowedStudyIds: deps.config.studyIds,
  });
  if (!auth.ok) {
    return auth.reason === 'missing-config'
      ? json({ error: 'integration-not-configured' }, 503)
      : json({ error: 'unauthorized' }, 401);
  }

  const upload = redactWebhookPayload(parsed.data);
  const result = await deps.store.enqueue(upload);
  return json(
    {
      status: result.created ? 'queued' : 'duplicate',
      uploadKey: uploadKey(upload),
      jobStatus: result.status,
    },
    200,
  );
}

function authorizeWorker(request: Request, config: SensorLoggerConfig): Response | null {
  if (!config.workerToken) return json({ error: 'integration-not-configured' }, 503);
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  return secretCodeMatches(token, config.workerToken) ? null : json({ error: 'unauthorized' }, 401);
}

/** Lease pending uploads to the bridge worker. */
export async function handleSensorLoggerClaim(
  request: Request,
  deps: SensorLoggerDeps,
): Promise<Response> {
  const denied = authorizeWorker(request, deps.config);
  if (denied) return denied;

  const body = await readBoundedText(request, MAX_WEBHOOK_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsedJson = body.text.trim() === '' ? { ok: true as const, value: {} } : parseJson(body.text);
  if (!parsedJson.ok) return json({ error: 'invalid-json' }, 400);
  const parsed = sensorLoggerClaimSchema.safeParse(parsedJson.value);
  if (!parsed.success) return json({ error: 'invalid-payload', issues: parsed.error.issues }, 400);

  const now = (deps.now ?? (() => new Date()))();
  const uploads = await deps.store.claim({
    limit: parsed.data.limit,
    staleBefore: new Date(now.getTime() - deps.config.claimTimeoutMs),
    maxAttempts: deps.config.maxAttempts,
  });
  return json({ uploads }, 200);
}

/**
 * Accept a `bridge scan` result (or a redacted failure) for a leased upload and
 * map its findings onto the map. Reports carry a deterministic `clientReportId`,
 * so a worker that retries after a network timeout cannot duplicate pins.
 */
export async function handleSensorLoggerCompletion(
  request: Request,
  deps: SensorLoggerDeps,
): Promise<Response> {
  const denied = authorizeWorker(request, deps.config);
  if (denied) return denied;

  const body = await readBoundedText(request, MAX_COMPLETION_BODY_BYTES);
  if (!body.ok) return body.response;

  const parsedJson = parseJson(body.text);
  if (!parsedJson.ok) return json({ error: 'invalid-json' }, 400);
  const parsed = sensorLoggerCompletionSchema.safeParse(parsedJson.value);
  if (!parsed.success) return json({ error: 'invalid-payload', issues: parsed.error.issues }, 400);

  const { studyId, uploadId, scan, bytes, error } = parsed.data;
  // Checked before anything is written: a completion for an upload nobody
  // webhooked must not leave reports on the map behind its 404.
  if (!(await deps.store.isKnown({ studyId, uploadId }))) {
    return json({ error: 'unknown-upload' }, 404);
  }

  if (!scan) {
    const known = await deps.store.complete({
      studyId,
      uploadId,
      status: 'FAILED',
      bytes,
      error: error ?? 'unspecified worker failure',
    });
    return known ? json({ status: 'failed' }, 200) : json({ error: 'unknown-upload' }, 404);
  }

  const reports = scanToReports({ studyId, uploadId }, scan);
  const reportCount = reports.length > 0 ? await deps.createReports(reports) : 0;
  const known = await deps.store.complete({
    studyId,
    uploadId,
    status: 'DONE',
    bytes,
    findingCount: scan.findings.length,
    reportCount,
    quality: scan.quality.verdict,
  });
  if (!known) return json({ error: 'unknown-upload' }, 404);

  return json(
    {
      status: 'done',
      findingCount: scan.findings.length,
      reportCount,
      quality: scan.quality.verdict,
    },
    200,
  );
}
