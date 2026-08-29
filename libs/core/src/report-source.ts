import { type ReportSource } from './obstacles';
import { type CaptureVerdict } from './scan';

/**
 * How an observation reached the map, and how that must be shown.
 *
 * A pin measured by a phone's accelerometer and a pin a human stood in front of
 * are different claims, so the map never presents them identically. Every cue
 * here is redundant on purpose: a glyph, a word and a stroke pattern, so the
 * distinction survives colour blindness, a greyscale print and a screen reader.
 */

export interface ReportSourceMark {
  source: ReportSource;
  /** Sentence-friendly provenance, e.g. for a list row or a popup. */
  label: string;
  /** One word for a badge. */
  short: string;
  /**
   * Non-colour marker cue. Rendered with `aria-hidden`, always alongside
   * `label`, so it is decoration on top of text rather than the only cue.
   */
  glyph: string;
  /** Leaflet `dashArray` for the marker outline; solid for a human's own pin. */
  dashArray?: string;
  /** Accessible name for the marker glyph. */
  ariaLabel: string;
}

export const REPORT_SOURCE_MARKS: Record<ReportSource, ReportSourceMark> = {
  MANUAL: {
    source: 'MANUAL',
    label: 'reported by a person',
    short: 'person',
    glyph: '\u25CF',
    ariaLabel: 'reported by a person',
  },
  VOICE: {
    source: 'VOICE',
    label: 'dictated by a person',
    short: 'dictated',
    glyph: '\u25CB',
    dashArray: '3',
    ariaLabel: 'dictated by a person',
  },
  SENSOR: {
    source: 'SENSOR',
    label: 'measured by phone sensors',
    short: 'sensor',
    glyph: '\u25C6',
    dashArray: '1 5',
    ariaLabel: 'measured by phone sensors',
  },
};

/** The mark for a stored `source`, defaulting to a human's own report. */
export function reportSourceMark(source: string | null | undefined): ReportSourceMark {
  return REPORT_SOURCE_MARKS[(source ?? 'MANUAL') as ReportSource] ?? REPORT_SOURCE_MARKS.MANUAL;
}

/** Whether a report was produced by the detector rather than by a human. */
export function isSensorReport(source: string | null | undefined): boolean {
  return source === 'SENSOR';
}

/** What a capture verdict means for the findings it produced. */
export const CAPTURE_VERDICT_LABELS: Record<CaptureVerdict, string> = {
  ok: 'good capture',
  degraded: 'degraded capture',
  unusable: 'unusable capture',
};

export function captureVerdictLabel(verdict: string | null | undefined): string | null {
  if (!verdict) return null;
  return CAPTURE_VERDICT_LABELS[verdict as CaptureVerdict] ?? verdict;
}

/**
 * The provenance line for a report: who or what observed it and, for a sensor
 * report, the verdict of the capture behind it. A finding from a degraded
 * recording says so wherever it appears, because the reader's decision about a
 * pavement depends on it.
 */
export function reportProvenanceLine(report: {
  source?: string | null;
  captureVerdict?: string | null;
}): string {
  const mark = reportSourceMark(report.source);
  if (mark.source !== 'SENSOR') return mark.label;
  const verdict = captureVerdictLabel(report.captureVerdict);
  return verdict ? `${mark.label} · ${verdict}` : mark.label;
}
