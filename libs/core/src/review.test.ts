import { describe, expect, it } from 'vitest';
import { parseVoiceReport } from './voice';
import {
  needsReview,
  PENDING_REVIEW,
  REVIEW_CONFIDENCE_FLOOR,
  reviewDecisionSchema,
  reviewedFields,
  reviewQueueSchema,
} from './review';

const parseConfidence = (transcript: string, recognition?: number) => {
  const parsed = parseVoiceReport(transcript, recognition);
  if (!parsed) throw new Error(`expected a parse for “${transcript}”`);
  return parsed.parseConfidence;
};

describe('needsReview', () => {
  it('publishes an utterance the parser could corroborate', () => {
    // Feature, explicit passability and a measurement: nothing to second-guess.
    expect(needsReview(parseConfidence('steps here, impassable, twenty cm high'))).toBe(false);
  });

  it('queues a bare keyword heard through a poor recogniser', () => {
    expect(needsReview(parseConfidence('kind of rough here', 0.3))).toBe(true);
  });

  it('is a floor, not a ceiling', () => {
    expect(needsReview(REVIEW_CONFIDENCE_FLOOR)).toBe(false);
    expect(needsReview(REVIEW_CONFIDENCE_FLOOR - 0.01)).toBe(true);
  });
});

describe('reviewQueueSchema', () => {
  it('defaults to a page a reviewer can actually work through', () => {
    expect(reviewQueueSchema.parse({})).toEqual({ limit: 25 });
  });

  it('caps the page size', () => {
    expect(reviewQueueSchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

describe('reviewDecisionSchema', () => {
  it('rejects a decision that names no action', () => {
    expect(reviewDecisionSchema.safeParse({ reportId: 'r1' }).success).toBe(false);
  });

  it('takes a correction of only the field the parser got wrong', () => {
    const decision = reviewDecisionSchema.parse({
      reportId: 'r1',
      action: 'correct',
      kind: 'STEPS',
    });
    expect(decision).toEqual({ reportId: 'r1', action: 'correct', kind: 'STEPS' });
  });

  it('refuses an unknown obstacle kind in a correction', () => {
    expect(
      reviewDecisionSchema.safeParse({ reportId: 'r1', action: 'correct', kind: 'PUDDLE' }).success,
    ).toBe(false);
  });
});

describe('reviewedFields', () => {
  it('publishes an approved report at its crowd confidence', () => {
    // The parse penalty is lifted: a human has read the transcript, so how well
    // the keyword parser did is no longer what limits the report.
    expect(reviewedFields({ reportId: 'r1', action: 'approve' }, 0.8)).toEqual({
      status: 'ACTIVE',
      confidence: 0.8,
    });
  });

  it('writes only the corrected fields', () => {
    expect(
      reviewedFields(
        { reportId: 'r1', action: 'correct', kind: 'STEPS', passability: 'IMPASSABLE' },
        0.7,
      ),
    ).toEqual({ status: 'ACTIVE', confidence: 0.7, kind: 'STEPS', passability: 'IMPASSABLE' });
  });

  it('clears a measurement the parser invented', () => {
    const fields = reviewedFields({ reportId: 'r1', action: 'correct', heightCm: null }, 0.7);
    expect(fields.heightCm).toBeNull();
    expect('widthCm' in fields).toBe(false);
  });

  it('keeps a rejected parse as a record instead of publishing it', () => {
    expect(reviewedFields({ reportId: 'r1', action: 'reject', reason: 'traffic noise' }, 0.9)).toEqual(
      { status: 'REJECTED', confidence: 0.9 },
    );
  });

  it('never leaves a decided report in the queue', () => {
    for (const action of ['approve', 'correct', 'reject'] as const) {
      expect(reviewedFields({ reportId: 'r1', action }, 0.5).status).not.toBe(PENDING_REVIEW);
    }
  });
});
