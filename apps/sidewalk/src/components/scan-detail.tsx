'use client';

import { captureVerdictLabel, reportSourceMark } from '@sidewalk/core';
import { api } from '@/trpc/client';

/**
 * The capture behind a scan's findings: which app on which phone, the sample
 * rate asked for against the rate delivered, the unit scale applied at ingest
 * and the detector threshold the findings came out of. A finding nobody can
 * inspect the settings of is a claim nobody can argue with, which is worse than
 * no finding at all.
 */
export function ScanDetail({ scanId }: { scanId: string }) {
  const detail = api.scan.byId.useQuery({ id: scanId });
  const mark = reportSourceMark('SENSOR');

  if (detail.isPending) {
    return (
      <p className="muted" role="status">
        Loading capture settings…
      </p>
    );
  }
  if (detail.error) {
    return (
      <p className="error" role="alert">
        {detail.error.message}
      </p>
    );
  }

  const scan = detail.data;
  const rows: [string, string][] = [
    ['Recorder', joinOrUnknown([scan.recorderApp, scan.recorderVersion])],
    ['Device', joinOrUnknown([scan.deviceModel, scan.platform])],
    ['Sample rate', rateLine(scan.requestedFsHz, scan.measuredFsHz)],
    ['Unit scale', scan.unitScale === null ? 'not recorded' : `×${scan.unitScale.toFixed(3)}`],
    [
      'Detector threshold',
      scan.detectorThreshold === null ? 'not recorded' : `z ≥ ${scan.detectorThreshold.toFixed(2)}`,
    ],
  ];

  return (
    <div className="scan-detail" id={`scan-detail-${scanId}`}>
      <p className="muted">
        <span className="source-tag" data-source="SENSOR">
          <span aria-hidden="true">{mark.glyph}</span> {mark.label}
        </span>{' '}
        · {captureVerdictLabel(scan.verdict) ?? scan.verdict} · {scan.format}
      </p>
      <dl className="scan-provenance">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {rows.every(([, value]) => value === 'not recorded') ? (
        <p className="muted">
          This scan was uploaded by a bridge build that did not report its capture settings.
        </p>
      ) : null}
    </div>
  );
}

function joinOrUnknown(parts: (string | null)[]): string {
  const present = parts.filter((part): part is string => Boolean(part));
  return present.length ? present.join(' · ') : 'not recorded';
}

function rateLine(requested: number | null, measured: number | null): string {
  if (requested === null && measured === null) return 'not recorded';
  const asked = requested === null ? '?' : `${requested.toFixed(0)} Hz`;
  const got = measured === null ? '?' : `${measured.toFixed(1)} Hz`;
  return `${asked} requested → ${got} measured`;
}
