import { describe, expect, it } from 'vitest';
import {
  authorizeWebhook,
  bridgeScanResultSchema,
  findingReportId,
  redactWebhookPayload,
  scanToReports,
  secretCodeMatches,
  sensorLoggerCompletionSchema,
  sensorLoggerWebhookSchema,
  uploadKey,
  type BridgeFinding,
  type BridgeScanResult,
} from './sensor-logger';

const payload = { studyId: 'study-1', uploadId: 'abc-123', secretCode: 'topsecret' };

const looseSlab: BridgeFinding = {
  index: 0,
  kind: 'loose_or_broken_element',
  description: 'rattling/impact-heavy: loose slab',
  start_m: 40,
  end_m: 46,
  peak_m: 43.2,
  score: 6.1,
  confidence: 0.9,
  lat: 51.5,
  lon: -0.124,
};

const softPatch: BridgeFinding = {
  index: 1,
  kind: 'compliant_or_absorbing',
  description: 'soft/absorbing: mat',
  start_m: 90,
  end_m: 94,
  peak_m: 92,
  score: -4.2,
  confidence: 0.55,
  lat: null,
  lon: null,
};

const scan: BridgeScanResult = {
  format: 'sensorlogger',
  quality: { verdict: 'ok', usable: true, reasons: [] },
  cadence_spm: 168.4,
  n_windows: 42,
  n_footfalls: 300,
  findings: [looseSlab, softPatch],
  notes: [],
};

describe('sensorLoggerWebhookSchema', () => {
  it('accepts the documented payload and strips unknown fields', () => {
    const parsed = sensorLoggerWebhookSchema.parse({ ...payload, extra: 'ignored' });
    expect(parsed).toEqual(payload);
  });

  it('rejects missing or non-opaque identifiers', () => {
    expect(sensorLoggerWebhookSchema.safeParse({ ...payload, studyId: '' }).success).toBe(false);
    expect(
      sensorLoggerWebhookSchema.safeParse({ ...payload, uploadId: '../../etc/passwd' }).success,
    ).toBe(false);
    expect(sensorLoggerWebhookSchema.safeParse({ studyId: 's', uploadId: 'u' }).success).toBe(false);
  });

  it('never carries the secret into a loggable object', () => {
    const redacted = redactWebhookPayload(payload);
    expect(redacted).toEqual({ studyId: 'study-1', uploadId: 'abc-123' });
    expect(JSON.stringify(redacted)).not.toContain('topsecret');
  });
});

describe('secretCodeMatches', () => {
  it('matches only an identical secret', () => {
    expect(secretCodeMatches('topsecret', 'topsecret')).toBe(true);
    expect(secretCodeMatches('topsecrez', 'topsecret')).toBe(false);
    expect(secretCodeMatches('topsecret ', 'topsecret')).toBe(false);
    expect(secretCodeMatches('top', 'topsecret')).toBe(false);
    expect(secretCodeMatches('topsecret', '')).toBe(false);
  });
});

describe('authorizeWebhook', () => {
  it('accepts a call carrying the configured study secret', () => {
    expect(authorizeWebhook(payload, { expectedSecretCode: 'topsecret' })).toEqual({ ok: true });
  });

  it('fails closed when the server has no secret configured', () => {
    expect(authorizeWebhook(payload, {})).toEqual({ ok: false, reason: 'missing-config' });
    expect(authorizeWebhook(payload, { expectedSecretCode: '' })).toEqual({
      ok: false,
      reason: 'missing-config',
    });
  });

  it('rejects a wrong secret', () => {
    expect(authorizeWebhook(payload, { expectedSecretCode: 'other' })).toEqual({
      ok: false,
      reason: 'bad-secret',
    });
  });

  it('enforces the study allowlist when one is configured', () => {
    expect(
      authorizeWebhook(payload, {
        expectedSecretCode: 'topsecret',
        allowedStudyIds: ['study-2'],
      }),
    ).toEqual({ ok: false, reason: 'unknown-study' });
    expect(
      authorizeWebhook(payload, {
        expectedSecretCode: 'topsecret',
        allowedStudyIds: ['study-1', 'study-2'],
      }),
    ).toEqual({ ok: true });
  });
});

describe('idempotency keys', () => {
  it('keys an upload by study and upload id', () => {
    expect(uploadKey(payload)).toBe('study-1/abc-123');
  });

  it('derives a stable per-finding report id', () => {
    expect(findingReportId(payload, 0)).toBe('sl:study-1:abc-123:0');
    expect(findingReportId(payload, 0)).toBe(findingReportId(payload, 0));
    expect(findingReportId(payload, 1)).not.toBe(findingReportId(payload, 0));
  });

  it('stays inside the 64-character clientReportId column', () => {
    const long = { studyId: 's'.repeat(120), uploadId: 'u'.repeat(36) };
    const id = findingReportId(long, 7);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.endsWith(':7')).toBe(true);
  });
});

describe('scanToReports', () => {
  it('maps geo-located findings onto ROUGH_SURFACE reports', () => {
    const reports = scanToReports(payload, scan);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      lat: 51.5,
      lng: -0.124,
      kind: 'ROUGH_SURFACE',
      passability: 'DIFFICULT',
      source: 'SENSOR',
      clientReportId: 'sl:study-1:abc-123:0',
    });
    expect(reports[0]?.note).toContain('43 m into the pass');
  });

  it('does not classify absorbing patches or low-confidence findings as difficult', () => {
    const reports = scanToReports(payload, {
      ...scan,
      findings: [
        { ...looseSlab, confidence: 0.4 },
        { ...softPatch, index: 2, lat: 51.5, lon: -0.124 },
      ],
    });
    expect(reports.map((r) => r.passability)).toEqual(['UNKNOWN', 'UNKNOWN']);
  });

  it('withholds every report when the capture failed the quality gate', () => {
    expect(
      scanToReports(payload, {
        ...scan,
        quality: { verdict: 'unusable', usable: false, reasons: ['GPS accuracy 9 m'] },
      }),
    ).toEqual([]);
  });

  it('flags a degraded capture in the note', () => {
    const reports = scanToReports(payload, {
      ...scan,
      quality: { verdict: 'degraded', usable: true, reasons: ['sample rate 120 Hz'] },
    });
    expect(reports[0]?.note).toContain('capture degraded');
  });
});

describe('bridgeScanResultSchema', () => {
  it('parses a scan emitted by `bridge scan --format json`', () => {
    expect(bridgeScanResultSchema.parse({ ...scan, source: '/tmp/upload.zip' }).findings).toHaveLength(
      2,
    );
  });

  it('rejects an unknown finding polarity or an out-of-range coordinate', () => {
    expect(
      bridgeScanResultSchema.safeParse({
        ...scan,
        findings: [{ ...looseSlab, kind: 'something_else' }],
      }).success,
    ).toBe(false);
    expect(
      bridgeScanResultSchema.safeParse({
        ...scan,
        findings: [{ ...looseSlab, lat: 91 }],
      }).success,
    ).toBe(false);
  });
});

describe('sensorLoggerCompletionSchema', () => {
  it('requires either a scan or an error', () => {
    expect(
      sensorLoggerCompletionSchema.safeParse({ studyId: 's', uploadId: 'u' }).success,
    ).toBe(false);
    expect(
      sensorLoggerCompletionSchema.safeParse({ studyId: 's', uploadId: 'u', error: 'download failed' })
        .success,
    ).toBe(true);
    expect(
      sensorLoggerCompletionSchema.safeParse({ studyId: 's', uploadId: 'u', scan, bytes: 245407 })
        .success,
    ).toBe(true);
  });

  it('refuses a completion that smuggles a secret-sized blob', () => {
    expect(
      sensorLoggerCompletionSchema.safeParse({
        studyId: 's',
        uploadId: 'u',
        error: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
  });
});
