import { z } from 'zod';
import { obstacleKindSchema, passabilitySchema, type Passability } from './obstacles';
import { parseVoiceReport } from './voice';

/**
 * Quality control for dictated reports.
 *
 * `parseVoiceReport` is keyword based, so it is confidently right about "steps
 * ahead, impassable" and only plausibly right about "watch out, kind of rough
 * here". Publishing the second straight to the map puts a guess in front of a
 * wheelchair user; dropping it throws away a real observation. So a weak parse
 * is held for review instead: it is stored with everything needed to judge it
 * (the transcript, what the parser understood, where it was spoken) and stays
 * off the public map until a human approves, corrects or rejects it.
 */

/**
 * Parses at or above this confidence are published immediately. Below it, the
 * report is queued. The floor sits under an unqualified keyword match with a
 * clear speech signal (0.6) so that only genuinely doubtful parses queue: a
 * transcript whose recogniser confidence was poor, or which named a feature
 * without saying anything else the parser could corroborate.
 */
export const REVIEW_CONFIDENCE_FLOOR = 0.5;

/** Report statuses this feature adds to the existing ACTIVE/RESOLVED/REJECTED. */
export const PENDING_REVIEW = 'PENDING_REVIEW';

/** Does this parse need a human before it reaches the map? */
export function needsReview(parseConfidence: number): boolean {
  return parseConfidence < REVIEW_CONFIDENCE_FLOOR;
}

export interface VoiceGate {
  status: 'ACTIVE' | typeof PENDING_REVIEW;
  /** Null when the report is not dictated, or when nothing could be parsed. */
  parseConfidence: number | null;
}

/**
 * The single rule every write path applies to a dictated report, so a client
 * cannot pick the lenient one. `report.create` and the offline `report.createMany`
 * accept `source: 'VOICE'` as well, and a transcript the server cannot
 * corroborate — including one it cannot parse at all, or a VOICE report that
 * arrives with no transcript to check — is queued rather than published.
 */
export function voiceGate(
  source: string,
  transcript: string | null | undefined,
  recognitionConfidence?: number | null,
): VoiceGate {
  if (source !== 'VOICE') return { status: 'ACTIVE', parseConfidence: null };

  const parsed = transcript ? parseVoiceReport(transcript, recognitionConfidence) : null;
  if (!parsed) return { status: PENDING_REVIEW, parseConfidence: null };

  return {
    status: needsReview(parsed.parseConfidence) ? PENDING_REVIEW : 'ACTIVE',
    parseConfidence: parsed.parseConfidence,
  };
}

/** Oldest first: a queued report is a runner still waiting for their report. */
export const reviewQueueSchema = z.object({
  limit: z.number().int().min(1).max(100).default(25),
  /** Cursor: only reports queued after this one, for paging a long backlog. */
  after: z.string().min(1).optional(),
});
export type ReviewQueueInput = z.infer<typeof reviewQueueSchema>;

/**
 * What a reviewer decided about a queued report.
 *
 * `correct` carries the fields the parser got wrong — a reviewer who is
 * listening to the transcript is the authority on what was said, so a
 * correction is stored verbatim rather than re-parsed.
 */
export const reviewDecisionSchema = z.discriminatedUnion('action', [
  z.object({ reportId: z.string().min(1), action: z.literal('approve') }),
  z.object({
    reportId: z.string().min(1),
    action: z.literal('correct'),
    kind: obstacleKindSchema.optional(),
    passability: passabilitySchema.optional(),
    heightCm: z.number().int().min(0).max(200).nullable().optional(),
    widthCm: z.number().int().min(0).max(1000).nullable().optional(),
    note: z.string().max(280).optional(),
  }),
  z.object({
    reportId: z.string().min(1),
    action: z.literal('reject'),
    /** Why, so the parser's failure modes are auditable. */
    reason: z.string().max(200).optional(),
  }),
]);
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>;

export interface ReviewedFields {
  status: 'ACTIVE' | 'REJECTED';
  kind?: string;
  passability?: Passability;
  heightCm?: number | null;
  widthCm?: number | null;
  note?: string;
  /** Confidence after review, given the report's crowd/GPS confidence. */
  confidence: number;
}

/**
 * The fields a decision writes.
 *
 * A reviewed report is no longer limited by how well the parser understood it —
 * a human has read the transcript — so the parse penalty is lifted and the
 * report keeps only the confidence its GPS accuracy and votes earn it. A
 * rejected report is kept rather than deleted: it is the record of what the
 * parser got wrong, and its author's other reports are not implicated.
 */
export function reviewedFields(
  decision: ReviewDecisionInput,
  crowdConfidence: number,
): ReviewedFields {
  if (decision.action === 'reject') {
    return { status: 'REJECTED', confidence: crowdConfidence };
  }
  if (decision.action === 'approve') {
    return { status: 'ACTIVE', confidence: crowdConfidence };
  }

  return {
    status: 'ACTIVE',
    confidence: crowdConfidence,
    ...(decision.kind ? { kind: decision.kind } : {}),
    ...(decision.passability ? { passability: decision.passability } : {}),
    ...(decision.heightCm !== undefined ? { heightCm: decision.heightCm } : {}),
    ...(decision.widthCm !== undefined ? { widthCm: decision.widthCm } : {}),
    ...(decision.note !== undefined ? { note: decision.note } : {}),
  };
}
