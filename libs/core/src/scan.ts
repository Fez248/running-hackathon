import { z } from 'zod';
import { latitudeSchema, longitudeSchema, type Passability } from './obstacles';
import { confidence } from './scoring';

/**
 * Surface scans: the seam between `apps/bridge` and the map.
 *
 * `apps/bridge` turns a phone IMU + GPS recording into geo-located floor
 * imperfections. `python -m bridge.cli scan <recording> --format map` writes
 * exactly the payload validated here, so a recorded walk becomes
 * `ROUGH_SURFACE` reports without a second detector on the TypeScript side.
 *
 * Field names mirror `bridge.scan.ScanResult.as_dict()` with two mechanical
 * conversions, applied once in `bridge.scan.to_map_payload`:
 * snake_case → camelCase (`cadence_spm` → `cadenceSpm`) and `lon` → `lng`,
 * the name the rest of this codebase uses for a longitude.
 */

/** Capture-quality verdicts from `bridge.quality.assess`. */
export const CAPTURE_VERDICTS = ['ok', 'degraded', 'unusable'] as const;
export type CaptureVerdict = (typeof CAPTURE_VERDICTS)[number];

export const captureVerdictSchema = z.enum(CAPTURE_VERDICTS);

/**
 * The capture certificate: what the recording itself was worth. It travels with
 * every finding so a claim about the pavement can always be traced back to the
 * evidence that produced it.
 */
export const captureQualitySchema = z.object({
  fsHz: z.number().min(0).max(10_000),
  jitterMs: z.number().min(0).max(60_000),
  dropoutFrac: z.number().min(0).max(1),
  durationS: z.number().min(0).max(86_400),
  gravityPresent: z.boolean(),
  clippingFrac: z.number().min(0).max(1),
  gpsPresent: z.boolean(),
  /** Median GPS accuracy in metres; absent when the track carried none. */
  gpsAccuracyM: z.number().min(0).max(500).nullish(),
  routeLengthM: z.number().min(0).max(1_000_000).nullish(),
  verdict: captureVerdictSchema,
  /** Failed hard checks, verbatim from the quality gate. */
  problems: z.array(z.string().max(300)).max(50).default([]),
  /** Soft checks that only downgrade the capture to `degraded`. */
  warnings: z.array(z.string().max(300)).max(50).default([]),
});
export type CaptureQuality = z.infer<typeof captureQualitySchema>;

/** Detector polarities, in `bridge.scan.DIRECTION_LABELS` vocabulary. */
export const SENSOR_FINDING_KINDS = ['loose_or_broken_element', 'compliant_or_absorbing'] as const;
export type SensorFindingKind = (typeof SENSOR_FINDING_KINDS)[number];

export const sensorFindingSchema = z.object({
  index: z.number().int().min(0).max(10_000),
  kind: z.enum(SENSOR_FINDING_KINDS),
  description: z.string().max(200).default(''),
  startM: z.number().min(0).max(1_000_000),
  endM: z.number().min(0).max(1_000_000),
  peakM: z.number().min(0).max(1_000_000),
  /** Robust z of the window that triggered the detection. */
  score: z.number(),
  confidence: z.number().min(0).max(1),
  lat: latitudeSchema,
  lng: longitudeSchema,
});
export type SensorFinding = z.infer<typeof sensorFindingSchema>;

/**
 * A recording's name without the path it happened to sit at. The bridge CLI is
 * given a local path, and the scan history is world-readable like the rest of
 * the map, so the home directory and username of whoever ran the detector must
 * not travel with the scan.
 */
export function scanSourceLabel(source: string): string {
  const name = source.split(/[/\\]/).filter(Boolean).pop() ?? '';
  return name || 'recording';
}

export const scanIngestSchema = z.object({
  /** Recording the findings came from; kept as a bare name, never a path. */
  source: z.string().min(1).max(200).transform(scanSourceLabel),
  /** Recording layout `bridge.ingest` recognised (`sensor_logger`, `csv`, …). */
  format: z.string().min(1).max(40),
  quality: captureQualitySchema,
  cadenceSpm: z.number().min(0).max(400),
  findings: z.array(sensorFindingSchema).max(500),
  /** Idempotency key for the whole scan, so a re-upload creates nothing new. */
  clientScanId: z.string().min(1).max(64),
});
export type ScanIngestInput = z.infer<typeof scanIngestSchema>;

/**
 * A finding's report is keyed by scan and finding index, which is what makes a
 * repeated upload of the same scan file idempotent.
 */
export function sensorReportClientId(clientScanId: string, findingIndex: number): string {
  return `${clientScanId}:${findingIndex}`;
}

/**
 * Passability of a surface finding: something that rattles is hard work for
 * every wheeled profile, something that absorbs (a mat, gravel, a wet patch)
 * needs a human to say whether it is passable at all.
 */
const PASSABILITY_BY_KIND: Record<SensorFindingKind, Passability> = {
  loose_or_broken_element: 'DIFFICULT',
  compliant_or_absorbing: 'UNKNOWN',
};

export interface SensorReportDraft {
  lat: number;
  lng: number;
  kind: 'ROUGH_SURFACE';
  passability: Passability;
  note: string;
  source: 'SENSOR';
  accuracyM: number | null;
  confidence: number;
  /**
   * The detector's own confidence, kept as a factor of its own so that a later
   * vote recomputing the crowd/GPS part cannot silently promote a weak
   * detection to the confidence of a human observation.
   */
  detectorConfidence: number;
  clientReportId: string;
}

/**
 * One finding as a report. The stored confidence is the crowd/GPS confidence of
 * a fresh unvoted report scaled by the detector's own confidence, so a weak
 * detection from a degraded capture never outranks a human observation.
 */
export function sensorFindingToReport(
  finding: SensorFinding,
  scan: Pick<ScanIngestInput, 'clientScanId' | 'quality'>,
): SensorReportDraft {
  const accuracyM = scan.quality.gpsAccuracyM ?? null;
  const extent = `${finding.startM.toFixed(1)}–${finding.endM.toFixed(1)} m along the route`;
  const note = `${finding.description ? `${finding.description}; ` : ''}${extent}`.slice(0, 280);

  return {
    lat: finding.lat,
    lng: finding.lng,
    kind: 'ROUGH_SURFACE',
    passability: PASSABILITY_BY_KIND[finding.kind],
    note,
    source: 'SENSOR',
    accuracyM,
    confidence: confidence({ agreeCount: 0, disagreeCount: 0, accuracyM }) * finding.confidence,
    detectorConfidence: finding.confidence,
    clientReportId: sensorReportClientId(scan.clientScanId, finding.index),
  };
}

/**
 * Reports a scan should create. An unusable capture yields none: the quality
 * gate refuses to make claims about a recording it cannot trust, and that
 * refusal must survive the trip into the map.
 */
export function sensorReportsForScan(scan: ScanIngestInput): SensorReportDraft[] {
  if (scan.quality.verdict === 'unusable') return [];
  return scan.findings.map((finding) => sensorFindingToReport(finding, scan));
}
