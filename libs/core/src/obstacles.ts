import { z } from 'zod';

/** Kinds of sidewalk features the crowd can report. */
export const OBSTACLE_KINDS = [
  'CURB',
  'STEPS',
  'ROADWORKS',
  'CROSSING',
  'NARROW_PATH',
  'BLOCKED',
  'STEEP_SLOPE',
  'ROUGH_SURFACE',
] as const;
export type ObstacleKind = (typeof OBSTACLE_KINDS)[number];

/** How usable a feature is for a wheeled user. */
export const PASSABILITY = ['PASSABLE', 'DIFFICULT', 'IMPASSABLE', 'UNKNOWN'] as const;
export type Passability = (typeof PASSABILITY)[number];

/** Who/what the report was captured by or is relevant for. */
export const PROFILES = ['WHEELCHAIR', 'STROLLER', 'COURIER', 'DELIVERY_ROBOT'] as const;
export type Profile = (typeof PROFILES)[number];

/** How an observation reached the map. */
export const REPORT_SOURCES = ['MANUAL', 'VOICE', 'SENSOR'] as const;
export type ReportSource = (typeof REPORT_SOURCES)[number];

export const obstacleKindSchema = z.enum(OBSTACLE_KINDS);
export const reportSourceSchema = z.enum(REPORT_SOURCES);
export const passabilitySchema = z.enum(PASSABILITY);
export const profileSchema = z.enum(PROFILES);

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

/**
 * Prefix reserved for scan-derived idempotency keys.
 *
 * `Report.clientReportId` is a single namespace shared by manual, dictated,
 * offline and detector writes. A key a client could also send would let a
 * generic report squat on a finding's key, and the scan would then adopt that
 * unrelated row instead of recording its own finding — so the detector's keys
 * live in a prefix the client-facing schemas refuse.
 */
export const SENSOR_REPORT_ID_PREFIX = 'sensor:';

/** Is this idempotency key one only the detector path may write? */
export function reservedClientReportId(clientReportId: string): boolean {
  return clientReportId.startsWith(SENSOR_REPORT_ID_PREFIX);
}

/** Client-supplied idempotency key, outside the detector's namespace. */
export const clientReportIdSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !reservedClientReportId(value), {
    message: `clientReportId must not start with "${SENSOR_REPORT_ID_PREFIX}"`,
  });

export const coordinateSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
});
export type Coordinate = z.infer<typeof coordinateSchema>;

/** Payload sent by a runner/rider while moving (kept tiny on purpose). */
export const createReportSchema = z.object({
  lat: latitudeSchema,
  lng: longitudeSchema,
  kind: obstacleKindSchema,
  passability: passabilitySchema.default('UNKNOWN'),
  /** Vertical obstacle size in cm (curb height, step rise). */
  heightCm: z.number().int().min(0).max(200).optional(),
  /** Usable path width in cm. */
  widthCm: z.number().int().min(0).max(1000).optional(),
  note: z.string().max(280).optional(),
  photoUrl: z.string().url().optional(),
  capturedByProfile: profileSchema.optional(),
  /** GPS accuracy in metres, used to weight confidence. */
  accuracyM: z.number().min(0).max(500).optional(),
  source: reportSourceSchema.default('MANUAL'),
  /** Raw dictated utterance when `source` is VOICE. */
  transcript: z.string().max(500).optional(),
  /** Run this report was captured during. */
  traceId: z.string().optional(),
  clientReportId: clientReportIdSchema.optional(),
});
export type CreateReportInput = z.infer<typeof createReportSchema>;

export const voteSchema = z.object({
  reportId: z.string().min(1),
  agree: z.boolean(),
});

/** Bounding-box query used by the map viewport. */
export const boundsSchema = z
  .object({
    minLat: latitudeSchema,
    maxLat: latitudeSchema,
    minLng: longitudeSchema,
    maxLng: longitudeSchema,
    kinds: z.array(obstacleKindSchema).optional(),
    profile: profileSchema.optional(),
    limit: z.number().int().min(1).max(1000).default(500),
  })
  .refine((b) => b.minLat <= b.maxLat && b.minLng <= b.maxLng, {
    message: 'Invalid bounds: min values must not exceed max values',
  });
export type BoundsInput = z.infer<typeof boundsSchema>;

export const OBSTACLE_LABELS: Record<ObstacleKind, string> = {
  CURB: 'Curb',
  STEPS: 'Steps',
  ROADWORKS: 'Roadworks',
  CROSSING: 'Crossing',
  NARROW_PATH: 'Narrow path',
  BLOCKED: 'Blocked path',
  STEEP_SLOPE: 'Steep slope',
  ROUGH_SURFACE: 'Rough surface',
};
