'use client';

import { useRef, useState } from 'react';
import { scanIngestSchema, type ScanIngestInput } from '@sidewalk/core';
import { api } from '@/trpc/client';

/** Human wording for the capture-quality gate's verdicts. */
const VERDICT_COPY: Record<string, string> = {
  ok: 'good capture',
  degraded: 'usable, with caveats',
  unusable: 'rejected — recapture needed',
};

/**
 * Import a bridge scan.
 *
 * `python -m bridge.cli scan <recording> --format map --out scan.json` writes a
 * file this panel uploads verbatim; the findings become ROUGH_SURFACE reports.
 * The payload is validated here as well as on the server so a mistyped file
 * (the wrong `--format`, say) is named locally instead of returning a wall of
 * field errors, and an unusable capture is reported as a rejection rather than
 * as an upload that quietly produced nothing.
 */
export function ScanPanel() {
  const utils = api.useUtils();
  const [payload, setPayload] = useState<ScanIngestInput | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const recent = api.scan.recent.useQuery({ limit: 5 });
  const ingest = api.scan.ingest.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.report.byBounds.invalidate(),
        utils.stats.summary.invalidate(),
        utils.scan.recent.invalidate(),
      ]);
    },
  });

  // Reading a file is async, so two quick picks can finish out of order and
  // leave the newest filename standing next to the older file's payload — the
  // upload would then send a scan the user had already replaced. Only the read
  // that is still the current selection may write to the panel.
  const selection = useRef(0);

  const readFile = async (file: File) => {
    const mine = ++selection.current;
    const isCurrent = () => selection.current === mine;

    setParseError(null);
    setPayload(null);
    setFileName(file.name);
    ingest.reset();

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      if (isCurrent()) setParseError('That file is not JSON. Export it with `--format map`.');
      return;
    }
    if (!isCurrent()) return;

    const parsed = scanIngestSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.join('.') || 'root';
      setParseError(
        `Not a bridge map payload: ${where} — ${issue?.message ?? 'invalid payload'}. ` +
          'Re-export the scan with `--format map`.',
      );
      return;
    }
    setPayload(parsed.data);
  };

  const quality = payload?.quality;
  const result = ingest.data;

  return (
    <details className="card">
      <summary>Import a phone scan</summary>
      <p className="muted">
        Upload a scan exported with{' '}
        <code>python -m bridge.cli scan &lt;recording&gt; --format map --out scan.json</code> — each
        finding becomes a rough-surface obstacle.
      </p>

      <label htmlFor="scan-file">Scan payload (JSON)</label>
      <input
        id="scan-file"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void readFile(file);
        }}
      />

      {parseError ? (
        <p className="error" role="alert">
          {parseError}
        </p>
      ) : null}

      {payload && quality ? (
        <>
          <p className="muted">
            {fileName} · {payload.source} ({payload.format}) ·{' '}
            {payload.findings.length === 1 ? '1 finding' : `${payload.findings.length} findings`}
          </p>
          <p>
            <span className="badge" data-verdict={quality.verdict}>
              {VERDICT_COPY[quality.verdict] ?? quality.verdict}
            </span>{' '}
            <span className="muted">
              {quality.fsHz.toFixed(0)} Hz · {quality.durationS.toFixed(0)} s
              {quality.gpsAccuracyM === null || quality.gpsAccuracyM === undefined
                ? ' · no GPS accuracy'
                : ` · GPS ±${quality.gpsAccuracyM.toFixed(1)} m`}
            </span>
          </p>
          {quality.problems.length ? (
            <ul className="muted">
              {quality.problems.map((problem) => (
                <li key={problem}>! {problem}</li>
              ))}
            </ul>
          ) : null}
          {quality.warnings.length ? (
            <ul className="muted">
              {quality.warnings.map((warning) => (
                <li key={warning}>~ {warning}</li>
              ))}
            </ul>
          ) : null}
          {quality.verdict === 'unusable' ? (
            <p className="muted">
              The capture failed the quality gate, so its findings are withheld. Uploading still
              records the attempt.
            </p>
          ) : null}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              className="primary"
              type="button"
              disabled={ingest.isPending}
              onClick={() => ingest.mutate(payload)}
            >
              {ingest.isPending ? 'Uploading…' : 'Upload scan'}
            </button>
          </div>
        </>
      ) : null}

      {result ? (
        <p role="status">
          {result.accepted
            ? `Ingested: ${result.reportIds.length} rough-surface ${
                result.reportIds.length === 1 ? 'report' : 'reports'
              } on the map.`
            : 'Scan recorded, but the capture was unusable — no reports were created.'}
        </p>
      ) : null}
      {ingest.error ? (
        <p className="error" role="alert">
          {ingest.error.message}
        </p>
      ) : null}

      {recent.data?.length ? (
        <>
          <span className="field-label">Recent scans</span>
          {recent.data.map((scan) => (
            <div className="report" key={scan.id}>
              <div>
                {scan.source}
                <span className="badge" data-verdict={scan.verdict}>
                  {scan.verdict}
                </span>
              </div>
              <div className="muted">
                {scan.reportCount} of {scan.findingCount} findings mapped ·{' '}
                {scan.cadenceSpm.toFixed(0)} spm
              </div>
            </div>
          ))}
        </>
      ) : null}
    </details>
  );
}
