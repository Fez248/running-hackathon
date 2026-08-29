/**
 * Sensor Logger Studies sync — the pure, transport-free half.
 *
 * Sensor Logger Cloud calls a Study webhook once per uploaded recording with
 * `{studyId, uploadId, secretCode}`; the recording itself is then downloaded
 * server-side and scanned by `apps/bridge`. This module owns everything about
 * that exchange that is neither HTTP nor database: payload validation, the
 * study secret comparison, the idempotency keys, and the mapping from bridge
 * findings onto the existing `Report` shape.
 *
 * See docs/SENSOR_LOGGER_SYNC.md for the endpoint contract and the upstream
 * references (STUDY_WEBHOOKS.md / STUDY_API.md).
 */

import { z } from 'zod';
import { latitudeSchema, longitudeSchema, type CreateReportInput } from './obstacles';

/** Identifiers are opaque strings upstream; bound them so a payload cannot be a blob. */
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'expected an opaque id of [A-Za-z0-9._:-]');

/**
 * Webhook body posted by Sensor Logger Cloud. Unknown keys are stripped rather
 * than rejected: upstream may add fields, and a 4xx would drop the recording
 * (the webhook is attempted once per upload).
 */
export const sensorLoggerWebhookSchema = z.object({
  studyId: identifierSchema,
  uploadId: identifierSchema,
  /** Study API authorization code. Sensitive: never persisted, logged or echoed. */
  secretCode: z.string().min(1).max(512),
});
export type SensorLoggerWebhookPayload = z.infer<typeof sensorLoggerWebhookSchema>;

/**
 * The only part of a webhook payload that may be logged or stored.
 * `secretCode` is dropped here so a caller cannot leak it by accident.
 */
export function redactWebhookPayload(payload: SensorLoggerWebhookPayload): {
  studyId: string;
  uploadId: string;
} {
  return { studyId: payload.studyId, uploadId: payload.uploadId };
}

/**
 * Length-independent string comparison for the study secret.
 *
 * Kept here (rather than using `node:crypto`) because `libs/core` must stay
 * importable from client bundles; the loop always visits every character of the
 * expected value so the timing carries no information about the shared prefix.
 */
export function secretCodeMatches(provided: string, expected: string): boolean {
  if (expected.length === 0) return false;
  let diff = provided.length ^ expected.length;
  for (let i = 0; i < expected.length; i += 1) {
    // Out-of-range reads yield NaN via charCodeAt, so index against the
    // expected length and fold a sentinel in for the missing characters.
    const a = i < provided.length ? provided.charCodeAt(i) : -1;
    diff |= a ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export const WEBHOOK_AUTH_FAILURES = ['missing-config', 'bad-secret', 'unknown-study'] as const;
export type WebhookAuthFailure = (typeof WEBHOOK_AUTH_FAILURES)[number];

export interface WebhookAuthConfig {
  /** Study secret code as configured on the server (`SENSOR_LOGGER_SECRET_CODE`). */
  expectedSecretCode?: string | null;
  /** Optional allowlist of study ids (`SENSOR_LOGGER_STUDY_IDS`). Empty = any study. */
  allowedStudyIds?: readonly string[];
}

/**
 * Authenticate a webhook call. There is no signature upstream, so the shared
 * study secret in the body is the credential; a missing server-side secret
 * fails closed rather than accepting anything.
 */
export function authorizeWebhook(
  payload: SensorLoggerWebhookPayload,
  config: WebhookAuthConfig,
): { ok: true } | { ok: false; reason: WebhookAuthFailure } {
  const expected = config.expectedSecretCode ?? '';
  if (!expected) return { ok: false, reason: 'missing-config' };
  if (!secretCodeMatches(payload.secretCode, expected)) return { ok: false, reason: 'bad-secret' };
  const allowed = config.allowedStudyIds ?? [];
  if (allowed.length > 0 && !allowed.includes(payload.studyId)) {
    return { ok: false, reason: 'unknown-study' };
  }
  return { ok: true };
}

/** Natural key of an upload: one Sensor Logger recording, forever. */
export function uploadKey(payload: { studyId: string; uploadId: string }): string {
  return `${payload.studyId}/${payload.uploadId}`;
}

/** FNV-1a (64-bit), used only to keep an over-long dedupe key inside its column. */
function fnv1a(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * `Report.clientReportId` namespace owned by this integration. Client-submitted
 * ids are refused in it, so an app client cannot pre-create (and thereby hijack,
 * since creation upserts) the row a future scan will write.
 */
export const SENSOR_REPORT_ID_PREFIX = 'sl:';

/** Whether a client-supplied `clientReportId` trespasses on a reserved namespace. */
export function isReservedClientReportId(clientReportId: string): boolean {
  return clientReportId.startsWith(SENSOR_REPORT_ID_PREFIX);
}

/**
 * Idempotency key for a report created from a finding. Reuses `Report.clientReportId`
 * (unique) so replaying a scan upserts instead of duplicating pins on the map.
 * Identifiers long enough to overflow the 64-character column collapse to a
 * hash of the same inputs, which is just as deterministic.
 */
export function findingReportId(
  payload: { studyId: string; uploadId: string },
  findingIndex: number,
): string {
  const readable = `${SENSOR_REPORT_ID_PREFIX}${payload.studyId}:${payload.uploadId}:${findingIndex}`;
  if (readable.length <= 64) return readable;
  return `${SENSOR_REPORT_ID_PREFIX}${fnv1a(uploadKey(payload))}:${findingIndex}`;
}

/** Bridge finding polarity -> label, as emitted by `bridge.scan.DIRECTION_LABELS`. */
export const BRIDGE_FINDING_KINDS = ['loose_or_broken_element', 'compliant_or_absorbing'] as const;
export type BridgeFindingKind = (typeof BRIDGE_FINDING_KINDS)[number];

/**
 * One finding from `bridge scan --format json`. Field names are snake_case
 * because they come straight from `ScanResult.as_dict()`; nothing rewrites them
 * on the way in.
 */
export const bridgeFindingSchema = z.object({
  index: z.number().int().min(0),
  kind: z.enum(BRIDGE_FINDING_KINDS),
  description: z.string().max(500),
  start_m: z.number().finite(),
  end_m: z.number().finite(),
  peak_m: z.number().finite(),
  score: z.number().finite(),
  confidence: z.number().min(0).max(1),
  lat: latitudeSchema.nullish(),
  lon: longitudeSchema.nullish(),
});
export type BridgeFinding = z.infer<typeof bridgeFindingSchema>;

export const bridgeQualitySchema = z.object({
  verdict: z.enum(['ok', 'degraded', 'unusable']),
  usable: z.boolean(),
  reasons: z.array(z.string().max(500)).max(50).default([]),
});

/** `ScanResult.as_dict()`, trimmed to what the server stores or maps. */
export const bridgeScanResultSchema = z.object({
  format: z.string().max(64),
  quality: bridgeQualitySchema,
  cadence_spm: z.number().finite().nonnegative(),
  n_windows: z.number().int().nonnegative(),
  n_footfalls: z.number().int().nonnegative(),
  findings: z.array(bridgeFindingSchema).max(500),
  notes: z.array(z.string().max(500)).max(50).default([]),
});
export type BridgeScanResult = z.infer<typeof bridgeScanResultSchema>;

/**
 * A finding is only mapped to a pin when it has a position *and* the capture
 * passed the quality gate: an unusable recording says something about the
 * recording, not about the pavement.
 */
export function isMappableFinding(finding: BridgeFinding): boolean {
  return (
    finding.lat !== null &&
    finding.lat !== undefined &&
    finding.lon !== null &&
    finding.lon !== undefined
  );
}

/**
 * Sensor findings are advisory: a rattling element is at least awkward for a
 * wheeled user, while an absorbing patch (mat, gravel) is not classified.
 */
function passabilityFor(finding: BridgeFinding): CreateReportInput['passability'] {
  return finding.kind === 'loose_or_broken_element' && finding.confidence >= 0.6
    ? 'DIFFICULT'
    : 'UNKNOWN';
}

function noteFor(finding: BridgeFinding, scan: BridgeScanResult): string {
  const quality = scan.quality.verdict === 'ok' ? '' : ` (capture ${scan.quality.verdict})`;
  return `${finding.description} — bridge scan, ${finding.peak_m.toFixed(0)} m into the pass, z=${finding.score.toFixed(1)}${quality}`.slice(
    0,
    280,
  );
}

/**
 * A mapped finding, with the detector's own confidence kept as a factor of its
 * own so a later vote recomputing the crowd/GPS part cannot promote a weak
 * detection to the confidence of a human observation (same contract as
 * `SensorReportDraft` for uploaded scans).
 */
export interface SensorLoggerReportDraft extends CreateReportInput {
  detectorConfidence: number;
}

/**
 * Map a bridge scan onto `report.createMany` input. Every report carries a
 * deterministic `clientReportId`, so re-running a scan for the same upload
 * updates nothing and creates nothing new.
 */
export function scanToReports(
  payload: { studyId: string; uploadId: string },
  scan: BridgeScanResult,
): SensorLoggerReportDraft[] {
  if (!scan.quality.usable) return [];
  return scan.findings.filter(isMappableFinding).map((finding) => ({
    lat: finding.lat as number,
    lng: finding.lon as number,
    kind: 'ROUGH_SURFACE' as const,
    passability: passabilityFor(finding),
    note: noteFor(finding, scan),
    source: 'SENSOR' as const,
    clientReportId: findingReportId(payload, finding.index),
    detectorConfidence: finding.confidence,
  }));
}

/** Lifecycle of one upload as tracked server-side. */
export const SENSOR_LOGGER_JOB_STATUSES = ['PENDING', 'CLAIMED', 'DONE', 'FAILED'] as const;
export type SensorLoggerJobStatus = (typeof SENSOR_LOGGER_JOB_STATUSES)[number];

/**
 * A lease token is minted per claim, so a completion proves the worker still
 * holds the upload it is reporting on.
 */
export const leaseTokenSchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);

export const sensorLoggerCompletionSchema = z
  .object({
    studyId: identifierSchema,
    uploadId: identifierSchema,
    leaseToken: leaseTokenSchema,
    /** Bytes downloaded from the Study API, for capacity monitoring. */
    bytes: z.number().int().min(0).max(2_000_000_000).optional(),
    scan: bridgeScanResultSchema.optional(),
    /** Failure reason, already redacted by the worker. */
    error: z.string().max(1000).optional(),
  })
  .refine((value) => value.scan !== undefined || value.error !== undefined, {
    message: 'a completion must carry either a scan result or an error',
  });
export type SensorLoggerCompletion = z.infer<typeof sensorLoggerCompletionSchema>;

export const sensorLoggerClaimSchema = z.object({
  /** How many uploads the worker wants to process in this cycle. */
  limit: z.number().int().min(1).max(25).default(5),
});
