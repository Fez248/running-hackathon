import { describe, expect, it } from 'vitest';
import { createReportSchema, reservedClientReportId } from './obstacles';
import { voiceReportSchema } from './voice';
import {
  scanIngestSchema,
  sensorFindingToReport,
  sensorReportClientId,
  sensorReportsForScan,
  type ScanIngestInput,
  type SensorFinding,
} from './scan';
import { confidence } from './scoring';

const QUALITY = {
  fsHz: 200,
  jitterMs: 0.4,
  dropoutFrac: 0,
  durationS: 120,
  gravityPresent: true,
  clippingFrac: 0,
  gpsPresent: true,
  gpsAccuracyM: 2.5,
  routeLengthM: 180,
  verdict: 'ok' as const,
  problems: [],
  warnings: [],
};

const FINDING: SensorFinding = {
  index: 0,
  kind: 'loose_or_broken_element',
  description: 'rattling/impact-heavy: loose slab, broken kerb, loose board',
  startM: 41.2,
  endM: 47.9,
  peakM: 44.5,
  score: 4.6,
  confidence: 0.8,
  lat: 52.5208,
  lng: 13.4095,
};

const scan = (overrides: Partial<ScanIngestInput> = {}): ScanIngestInput =>
  scanIngestSchema.parse({
    source: 'demo_pass',
    format: 'sensor_logger',
    quality: QUALITY,
    cadenceSpm: 168,
    findings: [FINDING],
    clientScanId: 'scan-1',
    ...overrides,
  });

describe('scanIngestSchema', () => {
  it('defaults the quality prose arrays so a minimal payload parses', () => {
    const parsed = scanIngestSchema.parse({
      source: 'demo_pass',
      format: 'csv',
      quality: { ...QUALITY, problems: undefined, warnings: undefined },
      cadenceSpm: 0,
      findings: [],
      clientScanId: 'scan-empty',
    });
    expect(parsed.quality.problems).toEqual([]);
    expect(parsed.quality.warnings).toEqual([]);
  });

  it('accepts a capture with no GPS accuracy column', () => {
    expect(
      scanIngestSchema.parse({
        source: 'demo_pass',
        format: 'csv',
        quality: { ...QUALITY, gpsAccuracyM: null, routeLengthM: null },
        cadenceSpm: 100,
        findings: [],
        clientScanId: 'scan-2',
      }).quality.gpsAccuracyM,
    ).toBeNull();
  });

  it('reduces the recording to a bare name, path and all', () => {
    expect(scan({ source: '/home/ada/Downloads/run 3.zip' }).source).toBe('run 3.zip');
    expect(scan({ source: 'C:\\Users\\ada\\rec' }).source).toBe('rec');
    expect(scan({ source: 'demo_pass' }).source).toBe('demo_pass');
    expect(scan({ source: '/' }).source).toBe('recording');
  });

  it('rejects two findings sharing one index', () => {
    expect(
      scanIngestSchema.safeParse({
        source: 'demo_pass',
        format: 'csv',
        quality: QUALITY,
        cadenceSpm: 100,
        findings: [FINDING, { ...FINDING, peakM: 60 }],
        clientScanId: 'scan-dup',
      }).success,
    ).toBe(false);
  });

  it('rejects a finding confidence outside 0..1', () => {
    expect(
      scanIngestSchema.safeParse({
        source: 'demo_pass',
        format: 'csv',
        quality: QUALITY,
        cadenceSpm: 100,
        findings: [{ ...FINDING, confidence: 1.4 }],
        clientScanId: 'scan-3',
      }).success,
    ).toBe(false);
  });
});

describe('sensorFindingToReport', () => {
  it('maps a rattling finding to a DIFFICULT rough surface report', () => {
    const report = sensorFindingToReport(FINDING, scan());
    expect(report.kind).toBe('ROUGH_SURFACE');
    expect(report.passability).toBe('DIFFICULT');
    expect(report.source).toBe('SENSOR');
    expect(report.note).toContain('41.2–47.9 m');
  });

  it('leaves an absorbing finding for a human to judge', () => {
    const report = sensorFindingToReport({ ...FINDING, kind: 'compliant_or_absorbing' }, scan());
    expect(report.passability).toBe('UNKNOWN');
  });

  it('keeps the detector confidence as its own factor for later votes', () => {
    expect(sensorFindingToReport(FINDING, scan()).detectorConfidence).toBe(0.8);
  });

  it('scales the crowd confidence by the detector confidence', () => {
    const report = sensorFindingToReport(FINDING, scan());
    expect(report.confidence).toBeCloseTo(
      confidence({ agreeCount: 0, disagreeCount: 0, accuracyM: 2.5 }) * 0.8,
      10,
    );
  });

  it('damps confidence further when the GPS was poor', () => {
    const coarse = sensorFindingToReport(FINDING, scan({ quality: { ...QUALITY, gpsAccuracyM: 40 } }));
    expect(coarse.confidence).toBeLessThan(sensorFindingToReport(FINDING, scan()).confidence);
  });

  it('derives an idempotency key from the scan and the finding index', () => {
    expect(sensorFindingToReport({ ...FINDING, index: 3 }, scan()).clientReportId).toBe(
      sensorReportClientId('scan-1', 3),
    );
  });
});

describe('sensorReportsForScan', () => {
  it('creates one report per finding', () => {
    const reports = sensorReportsForScan(scan({ findings: [FINDING, { ...FINDING, index: 1 }] }));
    expect(reports.map((report) => report.clientReportId)).toEqual([
      'sensor:scan-1:0',
      'sensor:scan-1:1',
    ]);
  });

  it('creates nothing for an unusable capture, however many findings it claims', () => {
    expect(
      sensorReportsForScan(
        scan({ quality: { ...QUALITY, verdict: 'unusable', problems: ['IMU sampled at 50 Hz'] } }),
      ),
    ).toEqual([]);
  });

  it('accepts a degraded capture', () => {
    expect(sensorReportsForScan(scan({ quality: { ...QUALITY, verdict: 'degraded' } }))).toHaveLength(1);
  });
});

describe('the detector id namespace', () => {
  const derived = sensorReportClientId('scan-1', 0);

  it('keeps scan-derived keys inside a namespace of their own', () => {
    expect(reservedClientReportId(derived)).toBe(true);
    expect(reservedClientReportId('offline-42')).toBe(false);
  });

  it('refuses a manual report claiming a scan-derived key', () => {
    const claim = createReportSchema.safeParse({
      lat: 52.37,
      lng: 4.9,
      kind: 'CURB',
      clientReportId: derived,
    });
    expect(claim.success).toBe(false);
  });

  it('refuses a dictated report claiming a scan-derived key', () => {
    const claim = voiceReportSchema.safeParse({
      transcript: 'broken pavement here',
      lat: 52.37,
      lng: 4.9,
      clientReportId: derived,
    });
    expect(claim.success).toBe(false);
  });

  it('still accepts a client key of its own', () => {
    expect(
      createReportSchema.safeParse({
        lat: 52.37,
        lng: 4.9,
        kind: 'CURB',
        clientReportId: 'offline-42',
      }).success,
    ).toBe(true);
  });
});
