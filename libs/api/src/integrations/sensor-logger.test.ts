import { beforeEach, describe, expect, it } from 'vitest';
import type { BridgeScanResult, CreateReportInput } from '@sidewalk/core';
import {
  handleSensorLoggerClaim,
  handleSensorLoggerCompletion,
  handleSensorLoggerWebhook,
  sensorLoggerConfigFromEnv,
  type ClaimedUpload,
  type CompletionRecord,
  type SensorLoggerConfig,
  type SensorLoggerDeps,
  type SensorLoggerUploadStore,
} from './sensor-logger';

const SECRET = 'study-secret-code';
const WORKER_TOKEN = 'worker-token';

const scan: BridgeScanResult = {
  format: 'sensorlogger',
  quality: { verdict: 'ok', usable: true, reasons: [] },
  cadence_spm: 168,
  n_windows: 40,
  n_footfalls: 280,
  findings: [
    {
      index: 0,
      kind: 'loose_or_broken_element',
      description: 'rattling/impact-heavy: loose slab',
      start_m: 40,
      end_m: 46,
      peak_m: 43,
      score: 6.1,
      confidence: 0.9,
      lat: 51.5,
      lon: -0.124,
    },
  ],
  notes: [],
};

interface Row {
  studyId: string;
  uploadId: string;
  status: 'PENDING' | 'CLAIMED' | 'DONE' | 'FAILED';
  attempts: number;
  claimedAt: Date | null;
  completion?: CompletionRecord;
}

/** In-memory stand-in for `prismaSensorLoggerStore`, same port. */
function fakeStore(): SensorLoggerUploadStore & { rows: Row[] } {
  const rows: Row[] = [];
  return {
    rows,
    async enqueue(upload) {
      const existing = rows.find(
        (row) => row.studyId === upload.studyId && row.uploadId === upload.uploadId,
      );
      if (existing) return { created: false, status: existing.status };
      rows.push({ ...upload, status: 'PENDING', attempts: 0, claimedAt: null });
      return { created: true, status: 'PENDING' };
    },
    async claim({ limit, staleBefore, maxAttempts }) {
      const claimable = rows.filter(
        (row) =>
          row.attempts < maxAttempts &&
          (row.status === 'PENDING' ||
            (row.status === 'CLAIMED' && row.claimedAt !== null && row.claimedAt < staleBefore)),
      );
      const leased: ClaimedUpload[] = [];
      for (const row of claimable.slice(0, limit)) {
        row.status = 'CLAIMED';
        row.attempts += 1;
        row.claimedAt = new Date();
        leased.push({ studyId: row.studyId, uploadId: row.uploadId, attempts: row.attempts });
      }
      return leased;
    },
    async complete(record) {
      const row = rows.find(
        (candidate) => candidate.studyId === record.studyId && candidate.uploadId === record.uploadId,
      );
      if (!row) return false;
      row.status = record.status;
      row.completion = record;
      return true;
    },
  };
}

let store: ReturnType<typeof fakeStore>;
let created: CreateReportInput[][];

function deps(overrides: Partial<SensorLoggerConfig> = {}): SensorLoggerDeps {
  return {
    store,
    createReports: async (reports) => {
      created.push(reports);
      return reports.length;
    },
    config: {
      secretCode: SECRET,
      studyIds: [],
      workerToken: WORKER_TOKEN,
      claimTimeoutMs: 60_000,
      maxAttempts: 3,
      ...overrides,
    },
  };
}

function webhookRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request('https://example.test/api/integrations/sensor-logger/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

function workerRequest(path: string, body: unknown, token: string | null = WORKER_TOKEN): Request {
  return new Request(`https://example.test/api/integrations/sensor-logger/jobs/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  store = fakeStore();
  created = [];
});

describe('sensorLoggerConfigFromEnv', () => {
  it('reads secrets, allowlist and limits, and treats blanks as unset', () => {
    expect(
      sensorLoggerConfigFromEnv({
        SENSOR_LOGGER_SECRET_CODE: ' abc ',
        SENSOR_LOGGER_STUDY_IDS: 'one, two ,',
        SENSOR_LOGGER_WORKER_TOKEN: '   ',
        SENSOR_LOGGER_CLAIM_TIMEOUT_MS: '5000',
        SENSOR_LOGGER_MAX_ATTEMPTS: 'not-a-number',
      }),
    ).toEqual({
      secretCode: 'abc',
      studyIds: ['one', 'two'],
      workerToken: null,
      claimTimeoutMs: 5000,
      maxAttempts: 5,
    });
  });
});

describe('POST webhook', () => {
  const payload = { studyId: 'study-1', uploadId: 'upload-1', secretCode: SECRET };

  it('queues an upload and answers 200', async () => {
    const response = await handleSensorLoggerWebhook(webhookRequest(payload), deps());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'queued', uploadKey: 'study-1/upload-1' });
    expect(store.rows).toHaveLength(1);
  });

  it('is idempotent: a replayed notification does not re-queue the recording', async () => {
    await handleSensorLoggerWebhook(webhookRequest(payload), deps());
    const replay = await handleSensorLoggerWebhook(webhookRequest(payload), deps());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: 'duplicate' });
    expect(store.rows).toHaveLength(1);
  });

  it('rejects a wrong secret without queueing anything', async () => {
    const response = await handleSensorLoggerWebhook(
      webhookRequest({ ...payload, secretCode: 'wrong' }),
      deps(),
    );
    expect(response.status).toBe(401);
    expect(store.rows).toHaveLength(0);
  });

  it('answers 503 when the integration is not configured', async () => {
    const response = await handleSensorLoggerWebhook(webhookRequest(payload), deps({ secretCode: null }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'integration-not-configured' });
  });

  it('honours the study allowlist', async () => {
    const response = await handleSensorLoggerWebhook(
      webhookRequest(payload),
      deps({ studyIds: ['other-study'] }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects malformed bodies and never echoes the payload back', async () => {
    const badJson = await handleSensorLoggerWebhook(webhookRequest('{not json'), deps());
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({ error: 'invalid-json' });

    const badShape = await handleSensorLoggerWebhook(
      webhookRequest({ studyId: 'study-1', secretCode: SECRET }),
      deps(),
    );
    expect(badShape.status).toBe(400);
    expect(JSON.stringify(await badShape.json())).not.toContain(SECRET);
  });

  it('refuses an oversized body before buffering it', async () => {
    const request = new Request('https://example.test/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '99999' },
      body: JSON.stringify(payload),
    });
    expect((await handleSensorLoggerWebhook(request, deps())).status).toBe(413);
  });
});

describe('POST jobs/claim', () => {
  beforeEach(async () => {
    await store.enqueue({ studyId: 'study-1', uploadId: 'upload-1' });
    await store.enqueue({ studyId: 'study-1', uploadId: 'upload-2' });
  });

  it('requires the worker token', async () => {
    expect((await handleSensorLoggerClaim(workerRequest('claim', {}, null), deps())).status).toBe(401);
    expect((await handleSensorLoggerClaim(workerRequest('claim', {}, 'nope'), deps())).status).toBe(401);
  });

  it('leases at most `limit` uploads and does not hand them out twice', async () => {
    const first = await handleSensorLoggerClaim(workerRequest('claim', { limit: 1 }), deps());
    expect(await first.json()).toEqual({
      uploads: [{ studyId: 'study-1', uploadId: 'upload-1', attempts: 1 }],
    });

    const second = await handleSensorLoggerClaim(workerRequest('claim', { limit: 5 }), deps());
    expect((await second.json()).uploads).toEqual([
      { studyId: 'study-1', uploadId: 'upload-2', attempts: 1 },
    ]);
  });

  it('rejects an out-of-range limit', async () => {
    expect((await handleSensorLoggerClaim(workerRequest('claim', { limit: 500 }), deps())).status).toBe(
      400,
    );
  });
});

describe('POST jobs/complete', () => {
  beforeEach(async () => {
    await store.enqueue({ studyId: 'study-1', uploadId: 'upload-1' });
  });

  it('turns a scan into reports and closes the upload', async () => {
    const response = await handleSensorLoggerCompletion(
      workerRequest('complete', { studyId: 'study-1', uploadId: 'upload-1', bytes: 245407, scan }),
      deps(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'done',
      findingCount: 1,
      reportCount: 1,
      quality: 'ok',
    });
    expect(created[0]?.[0]).toMatchObject({
      kind: 'ROUGH_SURFACE',
      source: 'SENSOR',
      clientReportId: 'sl:study-1:upload-1:0',
    });
    expect(store.rows[0]?.status).toBe('DONE');
  });

  it('creates no reports for a capture that failed the quality gate', async () => {
    const response = await handleSensorLoggerCompletion(
      workerRequest('complete', {
        studyId: 'study-1',
        uploadId: 'upload-1',
        scan: {
          ...scan,
          quality: { verdict: 'unusable', usable: false, reasons: ['median GPS accuracy 9 m'] },
        },
      }),
      deps(),
    );
    expect(await response.json()).toMatchObject({ reportCount: 0, quality: 'unusable' });
    expect(created).toEqual([]);
  });

  it('records a redacted worker failure', async () => {
    const response = await handleSensorLoggerCompletion(
      workerRequest('complete', {
        studyId: 'study-1',
        uploadId: 'upload-1',
        error: 'download failed: HTTP 403',
      }),
      deps(),
    );
    expect(await response.json()).toEqual({ status: 'failed' });
    expect(store.rows[0]?.status).toBe('FAILED');
    expect(store.rows[0]?.completion?.error).toBe('download failed: HTTP 403');
  });

  it('rejects a completion for an upload the server never received', async () => {
    const response = await handleSensorLoggerCompletion(
      workerRequest('complete', { studyId: 'study-1', uploadId: 'ghost', scan }),
      deps(),
    );
    expect(response.status).toBe(404);
  });

  it('rejects a completion that is neither a scan nor an error, and a bogus scan', async () => {
    expect(
      (
        await handleSensorLoggerCompletion(
          workerRequest('complete', { studyId: 'study-1', uploadId: 'upload-1' }),
          deps(),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSensorLoggerCompletion(
          workerRequest('complete', {
            studyId: 'study-1',
            uploadId: 'upload-1',
            scan: { ...scan, findings: [{ ...scan.findings[0], lat: 999 }] },
          }),
          deps(),
        )
      ).status,
    ).toBe(400);
  });

  it('requires the worker token', async () => {
    expect(
      (
        await handleSensorLoggerCompletion(
          workerRequest('complete', { studyId: 'study-1', uploadId: 'upload-1', scan }, null),
          deps(),
        )
      ).status,
    ).toBe(401);
  });
});
