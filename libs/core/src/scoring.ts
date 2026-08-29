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

/** Vertical rise a profile can still roll over, in cm. */
const MAX_CURB_HEIGHT_CM: Record<Profile, number> = {
  WHEELCHAIR: 3,
  STROLLER: 6,
  COURIER: 12,
  DELIVERY_ROBOT: 4,
};

/** Usable path width a profile needs, in cm. */
const MIN_WIDTH_CM: Record<Profile, number> = {
  WHEELCHAIR: 90,
  STROLLER: 75,
  COURIER: 60,
  DELIVERY_ROBOT: 70,
};

const SEVERITY: Record<Passability, number> = {
  PASSABLE: 0,
  UNKNOWN: 1,
  DIFFICULT: 2,
  IMPASSABLE: 3,
};

const worst = (a: Passability, b: Passability): Passability => (SEVERITY[a] >= SEVERITY[b] ? a : b);

function heightVerdict(profile: Profile, heightCm: number): Passability {
  const max = MAX_CURB_HEIGHT_CM[profile];
  if (heightCm <= max) return 'PASSABLE';
  return heightCm > max * 2 ? 'IMPASSABLE' : 'DIFFICULT';
}

function widthVerdict(profile: Profile, widthCm: number): Passability {
  const min = MIN_WIDTH_CM[profile];
  if (widthCm >= min) return 'PASSABLE';
  return widthCm < min * 0.75 ? 'IMPASSABLE' : 'DIFFICULT';
}

/**
 * Per-profile verdict for a reported feature: the worst of what the reporter
 * observed and what the measurements imply for this profile.
 */
export function passabilityForProfile(
  profile: Profile,
  feature: { heightCm?: number | null; widthCm?: number | null; passability: Passability },
): Passability {
  let verdict = feature.passability;
  if (feature.heightCm != null) verdict = worst(verdict, heightVerdict(profile, feature.heightCm));
  if (feature.widthCm != null) verdict = worst(verdict, widthVerdict(profile, feature.widthCm));
  return verdict;
}
