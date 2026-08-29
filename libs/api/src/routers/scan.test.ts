import { describe, expect, it, vi } from 'vitest';
import { scanIngestSchema, type ScanIngestInput } from '@sidewalk/core';
import type { TRPCContext } from '../trpc';
import { ingestScan } from './scan';

const QUALITY = {
  fsHz: 98.4,
  jitterMs: 0.6,
  dropoutFrac: 0,
  durationS: 987,
  gravityPresent: true,
  clippingFrac: 0,
  gpsPresent: true,
  gpsAccuracyM: 4.1,
  routeLengthM: 3110,
  verdict: 'degraded' as const,
  problems: [],
  warnings: [],
};

const payload = (overrides: Record<string, unknown> = {}): ScanIngestInput =>
  scanIngestSchema.parse({
    source: 'walk.zip',
    format: 'sensor_logger',
    quality: QUALITY,
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
    clientScanId: 'scan-prov-1',
    ...overrides,
  });

/** Just enough Prisma to observe what ingest writes. */
function fakePrisma() {
  const created: Record<string, unknown>[] = [];
  const tx = {
    surfaceScan: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: 'surface-scan-1', ...data };
      }),
    },
    report: { upsert: vi.fn(async () => ({ id: 'report-1' })) },
  };
  const prisma = {
    created,
    surfaceScan: { findUnique: vi.fn(async () => null) },
    $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return prisma as typeof prisma & TRPCContext['prisma'];
}

describe('ingestScan provenance', () => {
  it('persists the capture settings the bridge reported', async () => {
    const prisma = fakePrisma();
    await ingestScan(
      prisma,
      payload({
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
      }),
      null,
    );

    expect(prisma.created[0]).toMatchObject({
      recorderApp: 'Sensor Logger',
      recorderVersion: '1.34',
      deviceModel: 'iPhone 12 Pro Max',
      platform: 'ios',
      requestedFsHz: 100,
      measuredFsHz: 98.4,
      unitScale: 9.80665,
      detectorThreshold: 3.5,
    });
  });

  it('still ingests a payload from a bridge build that reports no provenance', async () => {
    const prisma = fakePrisma();
    const result = await ingestScan(prisma, payload(), null);

    expect(result.scan.id).toBe('surface-scan-1');
    expect(prisma.created[0]).toMatchObject({
      recorderApp: null,
      deviceModel: null,
      measuredFsHz: null,
      unitScale: null,
      detectorThreshold: null,
    });
  });

  it('resolves to the existing scan when the same upload arrives twice', async () => {
    const prisma = fakePrisma();
    prisma.surfaceScan.findUnique = vi.fn(async () => ({
      id: 'surface-scan-1',
      verdict: 'degraded',
      reports: [{ id: 'report-1' }],
    })) as unknown as typeof prisma.surfaceScan.findUnique;

    const result = await ingestScan(prisma, payload(), null);
    expect(result.reportIds).toEqual(['report-1']);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
