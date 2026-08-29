/**
 * Prisma-backed persistence for the Sensor Logger sync, plus the default
 * dependency bundle the Next route handlers use.
 *
 * SQLite (local file or Turso) has no queue, so `SensorLoggerUpload` is the
 * queue: an optimistic lease (`status` + `updatedAt` guard) is enough for the
 * single-worker deployment this integration targets, and the port in
 * `./sensor-logger` keeps a real queue a drop-in replacement.
 */

import { randomUUID } from 'node:crypto';
import { confidence, gridKey, type SensorLoggerReportDraft } from '@sidewalk/core';
import { prisma } from '@sidewalk/db';
import {
  sensorLoggerConfigFromEnv,
  type ClaimedUpload,
  type CompletionRecord,
  type EnqueueResult,
  type SensorLoggerDeps,
  type SensorLoggerUploadStore,
} from './sensor-logger';

type PrismaClientLike = typeof prisma;

/** Prisma's unique-constraint failure, without depending on its error classes. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

export function prismaSensorLoggerStore(client: PrismaClientLike = prisma): SensorLoggerUploadStore {
  return {
    async enqueue(upload): Promise<EnqueueResult> {
      try {
        await client.sensorLoggerUpload.create({ data: upload });
        return { created: true, status: 'PENDING' };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The webhook is retried by hand ("Test" in the Study editor) and
        // Sensor Logger may re-notify; a replay must not re-queue the work.
        const existing = await client.sensorLoggerUpload.findUnique({
          where: { studyId_uploadId: upload },
        });
        return { created: false, status: (existing?.status ?? 'PENDING') as EnqueueResult['status'] };
      }
    },

    async claim({ limit, staleBefore, maxAttempts }): Promise<ClaimedUpload[]> {
      const candidates = await client.sensorLoggerUpload.findMany({
        where: {
          attempts: { lt: maxAttempts },
          OR: [{ status: 'PENDING' }, { status: 'CLAIMED', claimedAt: { lt: staleBefore } }],
        },
        orderBy: { receivedAt: 'asc' },
        take: limit,
      });

      const claimed: ClaimedUpload[] = [];
      for (const candidate of candidates) {
        // Optimistic lock: `updatedAt` changes on every write, so a second
        // worker that got the same candidate updates nothing. The fresh token
        // is what makes the previous holder's completion stale.
        const leaseToken = randomUUID();
        const { count } = await client.sensorLoggerUpload.updateMany({
          where: { id: candidate.id, updatedAt: candidate.updatedAt },
          data: {
            status: 'CLAIMED',
            claimedAt: new Date(),
            attempts: candidate.attempts + 1,
            leaseToken,
          },
        });
        if (count === 1) {
          claimed.push({
            studyId: candidate.studyId,
            uploadId: candidate.uploadId,
            attempts: candidate.attempts + 1,
            leaseToken,
          });
        }
      }
      return claimed;
    },

    async hasActiveLease({ studyId, uploadId, leaseToken }): Promise<boolean> {
      const row = await client.sensorLoggerUpload.findUnique({
        where: { studyId_uploadId: { studyId, uploadId } },
        select: { status: true, leaseToken: true },
      });
      return row !== null && row.status === 'CLAIMED' && row.leaseToken === leaseToken;
    },

    async complete(record: CompletionRecord): Promise<boolean> {
      const { count } = await client.sensorLoggerUpload.updateMany({
        // Scoped to the lease: a worker whose lease expired mid-scan writes
        // nothing over the newer holder's row.
        where: {
          studyId: record.studyId,
          uploadId: record.uploadId,
          status: 'CLAIMED',
          leaseToken: record.leaseToken,
        },
        data: {
          status: record.status,
          completedAt: new Date(),
          error: record.error ?? null,
          bytes: record.bytes ?? null,
          findingCount: record.findingCount ?? null,
          reportCount: record.reportCount ?? null,
          quality: record.quality ?? null,
        },
      });
      return count > 0;
    },
  };
}

/**
 * Persist mapped findings. Every report carries a deterministic
 * `clientReportId`, so this is an upsert and a replayed scan is a no-op.
 *
 * The stored confidence is the crowd/GPS confidence of a fresh unvoted report
 * scaled by the detector's own confidence, which is kept alongside it and
 * re-applied whenever votes recompute confidence — the same contract as an
 * uploaded scan (`sensorFindingToReport`).
 */
export async function createSensorReports(
  reports: SensorLoggerReportDraft[],
  client: PrismaClientLike = prisma,
): Promise<number> {
  let written = 0;
  for (const report of reports) {
    const data = {
      lat: report.lat,
      lng: report.lng,
      gridKey: gridKey({ lat: report.lat, lng: report.lng }),
      kind: report.kind,
      passability: report.passability,
      note: report.note ?? null,
      accuracyM: report.accuracyM ?? null,
      source: report.source,
      clientReportId: report.clientReportId ?? null,
      confidence:
        confidence({ agreeCount: 0, disagreeCount: 0, accuracyM: report.accuracyM }) *
        report.detectorConfidence,
      detectorConfidence: report.detectorConfidence,
    };
    if (report.clientReportId) {
      await client.report.upsert({
        where: { clientReportId: report.clientReportId },
        update: {},
        create: data,
      });
    } else {
      await client.report.create({ data });
    }
    written += 1;
  }
  return written;
}

/** Default wiring for the route handlers: Prisma store + environment config. */
export function sensorLoggerDeps(): SensorLoggerDeps {
  return {
    store: prismaSensorLoggerStore(),
    createReports: (reports) => createSensorReports(reports),
    config: sensorLoggerConfigFromEnv(),
  };
}
