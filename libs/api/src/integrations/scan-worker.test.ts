import { describe, expect, it, vi } from 'vitest';
import type { ScanIngestInput } from '@sidewalk/core';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  handleRawScanUpload,
  handleScanWorkerStatus,
  scanWorkerConfigFromEnv,
  scanWorkerStatus,
  type ScanWorkerConfig,
  type ScanWorkerDeps,
} from './scan-worker';

const PAYLOAD = {
  source: '2026-08-29 14-05-11.zip',
  format: 'sensor_logger',
  quality: {
    fsHz: 98.4,
    jitterMs: 0.6,
    dropoutFrac: 0,
    durationS: 987,
    gravityPresent: true,
    clippingFrac: 0,
    gpsPresent: true,
    gpsAccuracyM: 4.1,
    routeLengthM: 3110,
    verdict: 'degraded',
    problems: [],
    warnings: ['short GPS gaps'],
  },
  cadenceSpm: 164,
  findings: [
    {
      index: 0,
      kind: 'loose_or_broken_element',
      description: 'rattling/impact-heavy',
      startM: 40,
      endM: 46,
      peakM: 43,
      score: 3.74,
      confidence: 0.7,
      lat: 41.39,
      lng: 2.16,
    },
  ],
  clientScanId: 'scan-raw-1',
  provenance: {
    recorderApp: 'Sensor Logger',
    recorderVersion: '1.34',
    deviceModel: 'iPhone 12 Pro Max',
    platform: 'ios',
    requestedFsHz: 100,
    measuredFsHz: 98.4,
    unitScale: 9.80665,
    detectorThreshold: 3.5,
  },
};

const config = (overrides: Partial<ScanWorkerConfig> = {}): ScanWorkerConfig => ({
  url: 'https://worker.example/scan',
  token: 'worker-token',
  maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
  timeoutMs: 5_000,
  ...overrides,
});

function deps(overrides: Partial<ScanWorkerDeps> = {}): ScanWorkerDeps & {
  ingested: ScanIngestInput[];
} {
  const ingested: ScanIngestInput[] = [];
  return {
    ingested,
    config: config(),
    ingest: async (payload) => {
      ingested.push(payload);
      return { scan: { id: 'surface-scan-1' }, reportIds: ['r1'], accepted: true };
    },
    ...overrides,
  };
}

function upload(files: { name: string; body: string }[] = [{ name: 'walk.zip', body: 'x' }]) {
  const form = new FormData();
  for (const file of files) form.append('file', new File([file.body], file.name));
  form.append('recording', 'walk.zip');
  return new Request('https://app.example/api/scan/raw', { method: 'POST', body: form });
}

describe('scanWorkerConfigFromEnv', () => {
  it('reads a configured worker', () => {
    const parsed = scanWorkerConfigFromEnv({
      SCAN_WORKER_URL: ' https://worker.example/scan ',
      SCAN_WORKER_TOKEN: 'tok',
      SCAN_WORKER_MAX_UPLOAD_BYTES: '1024',
      SCAN_WORKER_TIMEOUT_MS: '2000',
    });
    expect(parsed).toEqual({
      url: 'https://worker.example/scan',
      token: 'tok',
      maxUploadBytes: 1024,
      timeoutMs: 2000,
    });
  });

  it('treats an unset or non-HTTP worker as no worker at all', () => {
    expect(scanWorkerConfigFromEnv({}).url).toBeNull();
    expect(scanWorkerConfigFromEnv({ SCAN_WORKER_URL: 'file:///tmp/scan' }).url).toBeNull();
  });

  it('ignores nonsense limits rather than refusing every upload', () => {
    const parsed = scanWorkerConfigFromEnv({ SCAN_WORKER_MAX_UPLOAD_BYTES: 'lots' });
    expect(parsed.maxUploadBytes).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });
});

describe('scanWorkerStatus', () => {
  it('says why raw scanning is impossible when nothing is configured', () => {
    const status = scanWorkerStatus(config({ url: null }));
    expect(status.available).toBe(false);
    expect(status.reason).toContain('SCAN_WORKER_URL');
  });

  it('is available with a configured worker, and reports it over HTTP', async () => {
    expect(scanWorkerStatus(config()).available).toBe(true);
    const response = handleScanWorkerStatus(config());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ available: true, reason: null });
  });
});

describe('handleRawScanUpload', () => {
  it('refuses honestly, with a reason, when no worker is configured', async () => {
    const response = await handleRawScanUpload(upload(), deps({ config: config({ url: null }) }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.status).toBe('unavailable');
    expect(body.reason).toContain('SCAN_WORKER_URL');
  });

  it('rejects a recording bigger than the deployment accepts before scanning', async () => {
    const d = deps({ config: config({ maxUploadBytes: 4 }) });
    const response = await handleRawScanUpload(upload([{ name: 'walk.zip', body: 'xxxxxxxx' }]), d);
    expect(response.status).toBe(413);
    expect(d.ingested).toEqual([]);
  });

  it('rejects a form with no recording in it', async () => {
    const response = await handleRawScanUpload(
      new Request('https://app.example/api/scan/raw', { method: 'POST', body: new FormData() }),
      deps(),
    );
    expect(response.status).toBe(400);
  });

  it('forwards every file of a directory upload and ingests the payload', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(PAYLOAD), { status: 200 }),
    ) as unknown as typeof fetch;
    const d = deps({ fetchImpl });
    const response = await handleRawScanUpload(
      upload([
        { name: 'Accelerometer.csv', body: 'a' },
        { name: 'Gravity.csv', body: 'g' },
      ]),
      d,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'scanned',
      scanId: 'surface-scan-1',
      reportCount: 1,
      verdict: 'degraded',
    });

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://worker.example/scan');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer worker-token');
    expect((init.body as FormData).getAll('file')).toHaveLength(2);
    expect(d.ingested[0]?.provenance?.deviceModel).toBe('iPhone 12 Pro Max');
  });

  it('ingests a payload the worker wrapped in an envelope', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ scan: PAYLOAD }), { status: 200 }),
    ) as unknown as typeof fetch;
    const d = deps({ fetchImpl });
    expect((await handleRawScanUpload(upload(), d)).status).toBe(200);
    expect(d.ingested).toHaveLength(1);
  });

  it('writes nothing when the worker returns something that is not a scan', async () => {
    const cases: Response[] = [
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify({ findings: 'lots' }), { status: 200 }),
      new Response('boom', { status: 500 }),
    ];
    for (const workerResponse of cases) {
      const d = deps({ fetchImpl: (async () => workerResponse) as unknown as typeof fetch });
      const response = await handleRawScanUpload(upload(), d);
      expect(response.status).toBe(502);
      expect(d.ingested).toEqual([]);
    }
  });

  it('reports an unreachable worker instead of hanging or claiming success', async () => {
    const d = deps({
      fetchImpl: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const response = await handleRawScanUpload(upload(), d);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: 'worker-unreachable' });
    expect(d.ingested).toEqual([]);
  });
});
