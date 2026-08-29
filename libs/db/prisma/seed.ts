import { confidence, gridKey } from '@sidewalk/core';
import { prisma } from '../src/client';

/** Berlin Mitte, a walkable demo area for the hackathon. */
const CENTER = { lat: 52.5208, lng: 13.4095 };

type SeedReport = {
  dLat: number;
  dLng: number;
  kind: string;
  passability: string;
  heightCm?: number;
  widthCm?: number;
  note: string;
};

const REPORTS: SeedReport[] = [
  { dLat: 0.0008, dLng: 0.0012, kind: 'CURB', passability: 'DIFFICULT', heightCm: 8, note: 'High curb, no ramp on the north side' },
  { dLat: -0.0011, dLng: 0.0004, kind: 'CROSSING', passability: 'PASSABLE', heightCm: 0, note: 'Flush crossing with tactile paving' },
  { dLat: 0.0015, dLng: -0.0009, kind: 'STEPS', passability: 'IMPASSABLE', heightCm: 45, note: 'Four steps up to the passage' },
  { dLat: -0.0006, dLng: -0.0014, kind: 'ROADWORKS', passability: 'IMPASSABLE', note: 'Sidewalk fenced off, detour via the road' },
  { dLat: 0.0003, dLng: 0.0019, kind: 'NARROW_PATH', passability: 'DIFFICULT', widthCm: 70, note: 'Scooters parked across the pavement' },
  { dLat: -0.0018, dLng: 0.0011, kind: 'ROUGH_SURFACE', passability: 'DIFFICULT', note: 'Cobblestones, heavy vibration' },
  { dLat: 0.0021, dLng: 0.0002, kind: 'CROSSING', passability: 'PASSABLE', heightCm: 2, widthCm: 180, note: 'Wide dropped kerb, good for robots' },
  { dLat: -0.0002, dLng: -0.0021, kind: 'BLOCKED', passability: 'IMPASSABLE', note: 'Delivery van parked on the sidewalk' },
];

async function main() {
  const runner = await prisma.user.upsert({
    where: { handle: 'runner_ada' },
    update: {},
    create: { handle: 'runner_ada', displayName: 'Ada (runner)', profile: 'COURIER', points: 120 },
  });

  const rider = await prisma.user.upsert({
    where: { handle: 'rider_kai' },
    update: {},
    create: { handle: 'rider_kai', displayName: 'Kai (rider)', profile: 'WHEELCHAIR', points: 80 },
  });

  const trace = await prisma.trace.create({
    data: {
      userId: runner.id,
      path: JSON.stringify([
        [CENTER.lat, CENTER.lng],
        [CENTER.lat + 0.001, CENTER.lng + 0.001],
        [CENTER.lat + 0.002, CENTER.lng + 0.002],
      ]),
      distanceM: 1240,
      endedAt: new Date(),
    },
  });

  for (const [i, r] of REPORTS.entries()) {
    const lat = CENTER.lat + r.dLat;
    const lng = CENTER.lng + r.dLng;
    const agreeCount = (i % 4) + 1;
    const disagreeCount = i % 2;
    await prisma.report.create({
      data: {
        lat,
        lng,
        gridKey: gridKey({ lat, lng }),
        kind: r.kind,
        passability: r.passability,
        heightCm: r.heightCm ?? null,
        widthCm: r.widthCm ?? null,
        note: r.note,
        accuracyM: 6 + (i % 3) * 4,
        capturedByProfile: i % 2 === 0 ? 'COURIER' : 'WHEELCHAIR',
        authorId: i % 2 === 0 ? runner.id : rider.id,
        traceId: i % 2 === 0 ? trace.id : null,
        agreeCount,
        disagreeCount,
        confidence: confidence({ agreeCount, disagreeCount, accuracyM: 6 }),
      },
    });
  }

  const count = await prisma.report.count();
  console.log(`Seeded ${count} reports around ${CENTER.lat}, ${CENTER.lng}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
