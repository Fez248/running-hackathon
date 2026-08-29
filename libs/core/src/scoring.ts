import type { Passability, Profile } from './obstacles';

export interface ConfidenceInput {
  agreeCount: number;
  disagreeCount: number;
  accuracyM?: number | null;
}

/** Wilson-ish confidence in [0, 1], damped by poor GPS accuracy. */
export function confidence({ agreeCount, disagreeCount, accuracyM }: ConfidenceInput): number {
  const total = agreeCount + disagreeCount;
  const base = (agreeCount + 1) / (total + 2);
  const accuracyPenalty = accuracyM && accuracyM > 15 ? Math.min(0.4, (accuracyM - 15) / 100) : 0;
  return Math.max(0, Math.min(1, base - accuracyPenalty));
}

const MAX_CURB_HEIGHT_CM: Record<Profile, number> = {
  WHEELCHAIR: 3,
  STROLLER: 6,
  COURIER: 12,
  DELIVERY_ROBOT: 4,
};

const MIN_WIDTH_CM: Record<Profile, number> = {
  WHEELCHAIR: 90,
  STROLLER: 75,
  COURIER: 60,
  DELIVERY_ROBOT: 70,
};

/** Per-profile verdict for a reported feature. */
export function passabilityForProfile(
  profile: Profile,
  feature: { heightCm?: number | null; widthCm?: number | null; passability: Passability },
): Passability {
  if (feature.passability === 'IMPASSABLE') return 'IMPASSABLE';
  if (feature.heightCm != null && feature.heightCm > MAX_CURB_HEIGHT_CM[profile]) {
    return feature.heightCm > MAX_CURB_HEIGHT_CM[profile] * 3 ? 'IMPASSABLE' : 'DIFFICULT';
  }
  if (feature.widthCm != null && feature.widthCm < MIN_WIDTH_CM[profile]) {
    return 'IMPASSABLE';
  }
  return feature.passability;
}
