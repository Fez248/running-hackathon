/**
 * Raw recording uploads — the second door into the map.
 *
 * `scan.ingest` takes the payload `bridge scan --format map` already produced.
 * That leaves the person who did the walking with a laptop step: export, copy,
 * run the CLI, upload. This module lets the web app take the *recording* — the
 * Sensor Logger .zip or the exported directory — and hand it to a scan worker
 * that runs the Python detector, because `apps/sidewalk` runs on Node and can
 * never scan a recording itself.
 *
 * The worker is external and optional. Whether one exists is configuration, not
 * an assumption: `scanWorkerStatus` reports the truth to the browser, and when
 * there is no worker the panel prints the exact CLI command instead of
 * pretending to scan. A deployment with no worker is a supported deployment,
 * not a broken one.
 *
 * Worker contract (`SCAN_WORKER_URL`, POST, multipart/form-data):
 * - one `file` part per file of the recording; `filename` carries the path
 *   relative to the recording root, so a directory upload keeps its layout
 * - `Authorization: Bearer $SCAN_WORKER_TOKEN` when a token is configured
 * - responds `200` with the `bridge scan --format map` payload as JSON, either
 *   bare or wrapped as `{ "scan": … }`
 */

import { scanIngestSchema, type ScanIngestInput } from '@sidewalk/core';

/** A recording is big; anything past this is refused before it is read. */
export const DEFAULT_MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Scanning is CPU-bound Python; a slow worker must not hang the request. */
export const DEFAULT_WORKER_TIMEOUT_MS = 120_000;

export interface ScanWorkerConfig {
  /** Worker endpoint (`SCAN_WORKER_URL`). Absent = no server-side scanning. */
  url: string | null;
  /** Bearer token the worker authenticates us with (`SCAN_WORKER_TOKEN`). */
  token: string | null;
  maxUploadBytes: number;
  timeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function scanWorkerConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ScanWorkerConfig {
  const url = env.SCAN_WORKER_URL?.trim() || null;
  return {
    url: url && /^https?:\/\//.test(url) ? url : null,
    token: env.SCAN_WORKER_TOKEN?.trim() || null,
    maxUploadBytes: positiveInt(env.SCAN_WORKER_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES),
    timeoutMs: positiveInt(env.SCAN_WORKER_TIMEOUT_MS, DEFAULT_WORKER_TIMEOUT_MS),
  };
}

export interface ScanWorkerStatus {
  /** Whether this deployment can scan a raw recording server-side. */
  available: boolean;
  /** Why not, in words the panel shows verbatim. Null when available. */
  reason: string | null;
  maxUploadBytes: number;
}

/**
 * What this deployment can actually do. The panel asks before offering the raw
 * upload, so the offer is never made by a build that cannot honour it.
 */
export function scanWorkerStatus(config: ScanWorkerConfig): ScanWorkerStatus {
  if (!config.url) {
    return {
      available: false,
      reason:
        'No scan worker is configured for this deployment (SCAN_WORKER_URL is unset), so the ' +
        'recording cannot be scanned here.',
      maxUploadBytes: config.maxUploadBytes,
    };
  }
  return { available: true, reason: null, maxUploadBytes: config.maxUploadBytes };
}

export interface ScanWorkerDeps {
  config: ScanWorkerConfig;
  /** Persist a scanned payload; the tRPC ingest path, injected for testability. */
  ingest: (payload: ScanIngestInput) => Promise<{
    scan: { id: string };
    reportIds: string[];
    accepted: boolean;
  }>;
  fetchImpl?: typeof fetch;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Everything the panel needs to explain what happened, worker or not. */
export interface RawScanResponse {
  status: 'scanned' | 'unavailable';
  reason?: string;
  scanId?: string;
  reportCount?: number;
  accepted?: boolean;
  verdict?: string;
  source?: string;
}

/**
 * Accept a raw recording and put its findings on the map.
 *
 * Answers `503` with a reason when no worker is configured, so the browser can
 * fall back to the printed CLI command; a worker that fails answers `502` with
 * its own message rather than a silent nothing. The scan payload the worker
 * returns is validated against the same contract as an uploaded file, so a
 * misbehaving worker cannot write anything a hand upload could not.
 */
export async function handleRawScanUpload(
  request: Request,
  deps: ScanWorkerDeps,
): Promise<Response> {
  const status = scanWorkerStatus(deps.config);
  if (!status.available || !deps.config.url) {
    return json(
      { status: 'unavailable', reason: status.reason ?? undefined } satisfies RawScanResponse,
      503,
    );
  }

  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > deps.config.maxUploadBytes) {
    return json(
      {
        status: 'unavailable',
        reason: `That recording is larger than this deployment accepts (${Math.round(
          deps.config.maxUploadBytes / (1024 * 1024),
        )} MB).`,
      } satisfies RawScanResponse,
      413,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid-upload' }, 400);
  }

  const files = form.getAll('file').filter((part): part is File => part instanceof File);
  if (files.length === 0) return json({ error: 'no-recording' }, 400);

  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > deps.config.maxUploadBytes) {
    return json(
      {
        status: 'unavailable',
        reason: `That recording is larger than this deployment accepts (${Math.round(
          deps.config.maxUploadBytes / (1024 * 1024),
        )} MB).`,
      } satisfies RawScanResponse,
      413,
    );
  }

  const outbound = new FormData();
  for (const file of files) outbound.append('file', file, file.name);
  const recording = form.get('recording');
  if (typeof recording === 'string' && recording) outbound.append('recording', recording);

  const doFetch = deps.fetchImpl ?? fetch;
  let workerResponse: Response;
  try {
    workerResponse = await doFetch(deps.config.url, {
      method: 'POST',
      body: outbound,
      headers: deps.config.token ? { authorization: `Bearer ${deps.config.token}` } : undefined,
      signal: AbortSignal.timeout(deps.config.timeoutMs),
    });
  } catch (error) {
    return json(
      { error: 'worker-unreachable', message: error instanceof Error ? error.message : 'failed' },
      502,
    );
  }

  if (!workerResponse.ok) {
    // The worker's body may be an HTML error page; only its status is trusted.
    return json({ error: 'worker-failed', status: workerResponse.status }, 502);
  }

  let body: unknown;
  try {
    body = await workerResponse.json();
  } catch {
    return json({ error: 'worker-response-not-json' }, 502);
  }

  const envelope =
    typeof body === 'object' && body !== null && 'scan' in body
      ? (body as { scan: unknown }).scan
      : body;
  const parsed = scanIngestSchema.safeParse(envelope);
  if (!parsed.success) {
    return json({ error: 'worker-payload-invalid', issues: parsed.error.issues.slice(0, 3) }, 502);
  }

  const result = await deps.ingest(parsed.data);
  return json(
    {
      status: 'scanned',
      scanId: result.scan.id,
      reportCount: result.reportIds.length,
      accepted: result.accepted,
      verdict: parsed.data.quality.verdict,
      source: parsed.data.source,
    } satisfies RawScanResponse,
    200,
  );
}

/** Capability probe for the scan panel. */
export function handleScanWorkerStatus(config: ScanWorkerConfig): Response {
  return json(scanWorkerStatus(config), 200);
}
