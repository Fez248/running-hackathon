import { describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../trpc';
import { reportRouter } from './report';

/**
 * `SENSOR` provenance and the `sl:` idempotency namespace belong to the Sensor
 * Logger integration, which writes through `createSensorReports` rather than
 * through these public procedures. A client must not be able to claim either.
 */
const manual = {
  lat: 51.5,
  lng: -0.124,
  kind: 'ROUGH_SURFACE' as const,
  passability: 'DIFFICULT' as const,
  source: 'MANUAL' as const,
};

function caller(): ReturnType<typeof reportRouter.createCaller> {
  const prisma = {
    report: {
      create: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
  };
  return reportRouter.createCaller({ prisma, user: null } as unknown as TRPCContext);
}

describe('public report creation', () => {
  it('refuses a forged SENSOR source', async () => {
    await expect(caller().create({ ...manual, source: 'SENSOR' })).rejects.toThrow(/server-owned/);
    await expect(
      caller().createMany({ reports: [{ ...manual, source: 'SENSOR' }] }),
    ).rejects.toThrow(/server-owned/);
  });

  it('refuses a client id in the integration namespace', async () => {
    const clientReportId = 'sl:study-1:upload-1:0';
    await expect(caller().create({ ...manual, clientReportId })).rejects.toThrow(/reserved/);
    await expect(caller().createMany({ reports: [{ ...manual, clientReportId }] })).rejects.toThrow(
      /reserved/,
    );
    await expect(
      caller().createFromVoice({
        lat: manual.lat,
        lng: manual.lng,
        transcript: 'broken slab here',
        clientReportId,
      }),
    ).rejects.toThrow(/reserved/);
  });
});
