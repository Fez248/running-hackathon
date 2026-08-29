import { describe, expect, it } from 'vitest';
import {
  captureVerdictLabel,
  isSensorReport,
  reportProvenanceLine,
  reportSourceMark,
} from './report-source';

describe('reportSourceMark', () => {
  it('gives every source a word and a glyph, never colour alone', () => {
    for (const source of ['MANUAL', 'VOICE', 'SENSOR']) {
      const mark = reportSourceMark(source);
      expect(mark.glyph).not.toBe('');
      expect(mark.label).not.toBe('');
      expect(mark.ariaLabel).not.toBe('');
    }
  });

  it('marks a sensor report differently from a human one', () => {
    expect(reportSourceMark('SENSOR').glyph).not.toBe(reportSourceMark('MANUAL').glyph);
    expect(reportSourceMark('SENSOR').label).not.toBe(reportSourceMark('MANUAL').label);
  });

  it('falls back to a human report for an unknown or missing source', () => {
    expect(reportSourceMark(null).source).toBe('MANUAL');
    expect(reportSourceMark('SOMETHING_NEW').source).toBe('MANUAL');
  });

  it('recognises sensor provenance', () => {
    expect(isSensorReport('SENSOR')).toBe(true);
    expect(isSensorReport('VOICE')).toBe(false);
    expect(isSensorReport(undefined)).toBe(false);
  });
});

describe('captureVerdictLabel', () => {
  it('puts the verdict in words', () => {
    expect(captureVerdictLabel('ok')).toBe('good capture');
    expect(captureVerdictLabel('degraded')).toBe('degraded capture');
    expect(captureVerdictLabel('unusable')).toBe('unusable capture');
  });

  it('is absent when there is no capture behind the report', () => {
    expect(captureVerdictLabel(null)).toBeNull();
  });
});

describe('reportProvenanceLine', () => {
  it('states the capture verdict for a sensor report', () => {
    expect(reportProvenanceLine({ source: 'SENSOR', captureVerdict: 'degraded' })).toBe(
      'measured by phone sensors · degraded capture',
    );
  });

  it('omits a verdict a human report cannot have', () => {
    expect(reportProvenanceLine({ source: 'MANUAL', captureVerdict: 'ok' })).toBe(
      'reported by a person',
    );
  });

  it('still names the source when the verdict is missing', () => {
    expect(reportProvenanceLine({ source: 'SENSOR' })).toBe('measured by phone sensors');
  });
});
