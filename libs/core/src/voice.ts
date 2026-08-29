import { z } from 'zod';
import {
  coordinateSchema,
  latitudeSchema,
  longitudeSchema,
  obstacleKindSchema,
  passabilitySchema,
  profileSchema,
  type ObstacleKind,
  type Passability,
} from './obstacles';

/**
 * Ambient voice reporting.
 *
 * While running, the client keeps a speech recogniser open (Web Speech API on the
 * web, `SFSpeechRecognizer` on iOS) and pushes every final transcript through
 * `parseVoiceReport`. Recognition is noisy and hands-free, so parsing is keyword
 * based and deliberately conservative: a transcript that does not clearly name a
 * sidewalk feature yields `null` instead of a junk report on the map.
 */

/** Phrases that mark an utterance as an intentional report (optional). */
export const VOICE_TRIGGERS = ['report', 'log', 'mark', 'note', 'sidewalk map'] as const;

interface KindRule {
  kind: ObstacleKind;
  /** Matched against the lower-cased transcript. */
  phrases: readonly string[];
  /** Applied unless the transcript says otherwise. */
  passability: Passability;
}

const KIND_RULES: readonly KindRule[] = [
  { kind: 'STEPS', phrases: ['steps', 'stairs', 'staircase', 'step up', 'step down'], passability: 'IMPASSABLE' },
  { kind: 'ROADWORKS', phrases: ['roadworks', 'road works', 'construction', 'building site', 'scaffolding'], passability: 'IMPASSABLE' },
  { kind: 'CROSSING', phrases: ['crossing', 'crosswalk', 'zebra', 'dropped kerb', 'dropped curb', 'ramp'], passability: 'PASSABLE' },
  { kind: 'CURB', phrases: ['curb', 'kerb', 'curbstone'], passability: 'DIFFICULT' },
  { kind: 'NARROW_PATH', phrases: ['narrow', 'too tight', 'squeeze', 'bollard'], passability: 'DIFFICULT' },
  { kind: 'BLOCKED', phrases: ['blocked', 'parked car', 'parked van', 'bins', 'scooters', 'obstructed', 'obstruction'], passability: 'IMPASSABLE' },
  { kind: 'STEEP_SLOPE', phrases: ['steep', 'slope', 'incline', 'ramp too steep'], passability: 'DIFFICULT' },
  { kind: 'ROUGH_SURFACE', phrases: ['cobbles', 'cobblestone', 'cobblestones', 'gravel', 'potholes', 'pothole', 'broken paving', 'uneven', 'rough'], passability: 'DIFFICULT' },
];

const PASSABILITY_PHRASES: readonly { passability: Passability; phrases: readonly string[] }[] = [
  { passability: 'IMPASSABLE', phrases: ['impassable', 'not passable', 'no way through', 'cannot pass', "can't pass", 'completely blocked', 'dead end'] },
  { passability: 'DIFFICULT', phrases: ['difficult', 'hard to pass', 'tricky', 'just about', 'tight'] },
  { passability: 'PASSABLE', phrases: ['passable', 'fine', 'no problem', 'easy', 'clear', 'smooth', 'accessible'] },
];

/** "about fifteen centimetres" → 15. Speech engines spell small numbers out. */
const SPELLED_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};

const CM_UNITS = '(?:cm|centimetre|centimeter|centimetres|centimeters)';

const NUMBER_WORDS = Object.keys(SPELLED_NUMBERS).join('|');

/** "one hundred and twenty five" → 125. Filler words such as "and" are ignored. */
function spelledNumber(words: readonly string[]): number | null {
  let total = 0;
  let group = 0;
  let seen = false;

  for (const word of words) {
    const value = SPELLED_NUMBERS[word];
    if (value == null) continue;
    seen = true;
    if (value === 100) {
      total += Math.max(group, 1) * 100;
      group = 0;
    } else {
      group += value;
    }
  }

  return seen ? total + group : null;
}

const HEIGHT_WORDS = /high|tall|height|deep|depth|step/g;
const WIDTH_WORDS = /wide|width|narrow/g;

/** Character distance from a span to the closest qualifier of that dimension. */
function qualifierDistance(text: string, words: RegExp, start: number, end: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (const match of text.matchAll(words)) {
    if (match.index == null) continue;
    const distance =
      match.index > end ? match.index - end : Math.max(0, start - (match.index + match[0].length));
    best = Math.min(best, distance);
  }
  return best;
}

interface Measurement {
  value: number;
  /** Which dimension the surrounding words attribute it to. */
  dimension: 'height' | 'width' | null;
}

/**
 * Every centimetre measurement in the utterance, attributed to a dimension by
 * the words around it, so "fifteen centimetre curb on a one metre wide path"
 * does not record the curb height as the path width.
 */
function measurements(text: string): Measurement[] {
  const term = `(?:\\d{1,3}|${NUMBER_WORDS}|and)`;
  const pattern = new RegExp(`((?:${term}\\s+){0,3}${term})\\s*${CM_UNITS}`, 'g');
  const found: Measurement[] = [];

  for (const match of text.matchAll(pattern)) {
    const raw = match[1]?.trim();
    if (!raw || match.index == null) continue;
    const digits = /(\d{1,3})\s*$/.exec(raw);
    const value = digits?.[1] ? Number(digits[1]) : spelledNumber(raw.split(/\s+/));
    if (value == null) continue;

    // Attributed to whichever qualifier sits closest, within a few words.
    const start = match.index;
    const end = match.index + match[0].length;
    const height = qualifierDistance(text, HEIGHT_WORDS, start, end);
    const width = qualifierDistance(text, WIDTH_WORDS, start, end);
    const nearest = Math.min(height, width);
    found.push({
      value,
      dimension: nearest > 24 || height === width ? null : height < width ? 'height' : 'width',
    });
  }

  return found;
}

export interface ParsedVoiceReport {
  kind: ObstacleKind;
  passability: Passability;
  heightCm?: number;
  widthCm?: number;
  /** The transcript, trimmed of the trigger phrase, stored as the note. */
  note: string;
  /** Which phrase matched, useful for showing the user why we understood X. */
  matchedPhrase: string;
  /** 0..1 heuristic: keyword strength × recogniser confidence. */
  parseConfidence: number;
}

export function stripTrigger(transcript: string): string {
  let text = transcript.trim();
  for (const trigger of VOICE_TRIGGERS) {
    const pattern = new RegExp(`^${trigger}[\\s,:-]+`, 'i');
    if (pattern.test(text)) {
      text = text.replace(pattern, '').trim();
      break;
    }
  }
  return text;
}

/**
 * Turn one utterance into a report, or `null` when nothing recognisable was said.
 * `recognitionConfidence` is the speech engine's own 0..1 score, when available.
 */
export function parseVoiceReport(
  transcript: string,
  recognitionConfidence?: number | null,
): ParsedVoiceReport | null {
  const note = stripTrigger(transcript);
  const text = note.toLowerCase();
  if (!text) return null;

  let match: { rule: KindRule; phrase: string } | null = null;
  for (const rule of KIND_RULES) {
    for (const phrase of rule.phrases) {
      if (!text.includes(phrase)) continue;
      // Prefer the longest matching phrase so "dropped kerb" beats "kerb".
      if (!match || phrase.length > match.phrase.length) match = { rule, phrase };
    }
  }
  if (!match) return null;

  let passability = match.rule.passability;
  let explicitPassability = false;
  for (const entry of PASSABILITY_PHRASES) {
    if (entry.phrases.some((phrase) => text.includes(phrase))) {
      passability = entry.passability;
      explicitPassability = true;
      break;
    }
  }

  const sizes = measurements(text);
  const widthCm = sizes.find((size) => size.dimension === 'width')?.value ?? null;
  // An unqualified measurement is read as a height: "a curb about 15 cm".
  const heightCm =
    sizes.find((size) => size.dimension === 'height')?.value ??
    (widthCm == null ? sizes.find((size) => size.dimension === null)?.value ?? null : null);

  const keywordStrength = 0.6 + (explicitPassability ? 0.2 : 0) + (heightCm != null ? 0.1 : 0);
  const parseConfidence = Math.max(
    0,
    Math.min(1, keywordStrength * (recognitionConfidence == null ? 1 : Math.max(0.4, recognitionConfidence))),
  );

  return {
    kind: match.rule.kind,
    passability,
    ...(heightCm != null ? { heightCm } : {}),
    ...(widthCm != null ? { widthCm } : {}),
    note: note.slice(0, 280),
    matchedPhrase: match.phrase,
    parseConfidence,
  };
}

/** Wire schema for a dictated report geocoded to the runner's live position. */
export const voiceReportSchema = z.object({
  transcript: z.string().min(1).max(500),
  lat: latitudeSchema,
  lng: longitudeSchema,
  accuracyM: z.number().min(0).max(500).optional(),
  /** Speech engine confidence, 0..1. */
  recognitionConfidence: z.number().min(0).max(1).optional(),
  capturedByProfile: profileSchema.optional(),
  traceId: z.string().optional(),
  clientReportId: z.string().min(1).max(64).optional(),
});
export type VoiceReportInput = z.infer<typeof voiceReportSchema>;

/** Viewport query for the fog overlay (no filters, just a bounding box). */
export const coverageBoundsSchema = z
  .object({
    minLat: latitudeSchema,
    maxLat: latitudeSchema,
    minLng: longitudeSchema,
    maxLng: longitudeSchema,
    limit: z.number().int().min(1).max(20_000).default(8_000),
  })
  .refine((b) => b.minLat <= b.maxLat && b.minLng <= b.maxLng, {
    message: 'Invalid bounds: min values must not exceed max values',
  });
export type CoverageBoundsInput = z.infer<typeof coverageBoundsSchema>;

/** Wire schema for revealing fog along a batch of accepted GPS fixes. */
export const coverageRevealSchema = z.object({
  points: z.array(coordinateSchema).min(1).max(500),
  revealRadiusM: z.number().min(5).max(100).optional(),
  /** Best GPS accuracy in the batch, recorded on cells this call first reveals. */
  accuracyM: z.number().min(0).max(500).optional(),
  traceId: z.string().optional(),
});
export type CoverageRevealInput = z.infer<typeof coverageRevealSchema>;
