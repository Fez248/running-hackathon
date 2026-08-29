import { describe, expect, it } from 'vitest';
import { parseVoiceReport, stripTrigger, voiceReportSchema } from './voice';

describe('stripTrigger', () => {
  it('removes a leading trigger word', () => {
    expect(stripTrigger('Report: high curb here')).toBe('high curb here');
  });

  it('leaves other speech untouched', () => {
    expect(stripTrigger('high curb here')).toBe('high curb here');
  });
});

describe('parseVoiceReport', () => {
  it('recognises a dictated curb with a height', () => {
    const parsed = parseVoiceReport('report high curb about 15 cm, difficult');
    expect(parsed).toMatchObject({ kind: 'CURB', passability: 'DIFFICULT', heightCm: 15 });
  });

  it('understands spelled-out numbers from the recogniser', () => {
    expect(parseVoiceReport('curb around fifteen centimetres')?.heightCm).toBe(15);
  });

  it('composes spelled-out tens and hundreds', () => {
    expect(parseVoiceReport('curb twenty five centimetres')?.heightCm).toBe(25);
    expect(parseVoiceReport('curb one hundred centimetres')?.heightCm).toBe(100);
    expect(parseVoiceReport('curb one hundred and twenty five centimetres')?.heightCm).toBe(125);
  });

  it('keeps height and width apart when both are dictated', () => {
    expect(parseVoiceReport('high curb fifteen centimetres, path eighty centimetres wide')).toMatchObject({
      heightCm: 15,
      widthCm: 80,
    });
    expect(parseVoiceReport('narrow path sixty centimetres wide next to a 20 cm high curb')).toMatchObject({
      heightCm: 20,
      widthCm: 60,
    });
  });

  it('prefers the longest matching phrase', () => {
    expect(parseVoiceReport('nice dropped kerb here')).toMatchObject({
      kind: 'CROSSING',
      matchedPhrase: 'dropped kerb',
    });
  });

  it('lets an explicit verdict override the default passability', () => {
    expect(parseVoiceReport('cobblestones but totally fine')?.passability).toBe('PASSABLE');
    expect(parseVoiceReport('crossing is impassable')?.passability).toBe('IMPASSABLE');
  });

  it('captures width when the speaker says wide', () => {
    expect(parseVoiceReport('narrow path only 60 cm wide')).toMatchObject({
      kind: 'NARROW_PATH',
      widthCm: 60,
    });
  });

  it('keeps the utterance as the note', () => {
    expect(parseVoiceReport('report scaffolding across the pavement')?.note).toBe(
      'scaffolding across the pavement',
    );
  });

  it('ignores ambient chatter with no sidewalk feature', () => {
    expect(parseVoiceReport('what a nice morning for a run')).toBeNull();
    expect(parseVoiceReport('   ')).toBeNull();
  });

  it('damps confidence when the recogniser is unsure', () => {
    const sure = parseVoiceReport('steps blocking the path', 1);
    const unsure = parseVoiceReport('steps blocking the path', 0.5);
    expect(sure!.parseConfidence).toBeGreaterThan(unsure!.parseConfidence);
  });
});

describe('voiceReportSchema', () => {
  it('requires a transcript and a position', () => {
    expect(
      voiceReportSchema.safeParse({ transcript: 'curb', lat: 52.5, lng: 13.4 }).success,
    ).toBe(true);
    expect(voiceReportSchema.safeParse({ transcript: 'curb', lat: 999, lng: 13.4 }).success).toBe(
      false,
    );
  });
});
