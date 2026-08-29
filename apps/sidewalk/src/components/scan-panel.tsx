'use client';

import { useEffect, useState } from 'react';
import {
  captureVerdictLabel,
  isRawExportFileName,
  recordingLabelForFiles,
  scanCliCommand,
  scanIngestSchema,
  type ScanIngestInput,
} from '@sidewalk/core';
import { api } from '@/trpc/client';
import { ScanDetail } from './scan-detail';

/** Human wording for the capture-quality gate's verdicts. */
const VERDICT_COPY: Record<string, string> = {
  ok: 'good capture',
  degraded: 'usable, with caveats',
  unusable: 'rejected — recapture needed',
};

interface WorkerStatus {
  available: boolean;
  reason: string | null;
  maxUploadBytes: number;
}

interface RawScanOutcome {
  status: 'scanned' | 'unavailable';
  reason?: string;
  reportCount?: number;
  accepted?: boolean;
  verdict?: string;
}

/** Files from a `webkitdirectory` input carry their path inside the directory. */
function relativePathOf(file: File): string | null {
  const withPath = file as File & { webkitRelativePath?: string };
  return withPath.webkitRelativePath || null;
}

/**
 * Import a bridge scan.
 *
 * Two doors, because a deployment may or may not have a scan worker:
 *
 * - the raw recording — the Sensor Logger `.zip` or the exported directory —
 *   goes straight from the phone to the map where a worker exists, which is the
 *   whole point: the laptop steps disappear;
 * - where no worker exists the panel says so and prints the exact command to
 *   run locally, with the picked file's name already in it, and the JSON the
 *   CLI writes is uploaded here as before.
 *
 * Capability is asked of the server (`/api/scan/worker`) rather than assumed, so
 * the offer is never made by a build that cannot honour it. The payload is
 * validated in the browser as well as on the server so a mistyped file (the
 * wrong `--format`, say) is named locally instead of returning a wall of field
 * errors, and an unusable capture is reported as a rejection rather than as an
 * upload that quietly produced nothing.
 */
export function ScanPanel() {
  const utils = api.useUtils();
  const [payload, setPayload] = useState<ScanIngestInput | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [worker, setWorker] = useState<WorkerStatus | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [rawBusy, setRawBusy] = useState(false);
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawOutcome, setRawOutcome] = useState<RawScanOutcome | null>(null);
  const [openScanId, setOpenScanId] = useState<string | null>(null);

  const recent = api.scan.recent.useQuery({ limit: 5 });
  const ingest = api.scan.ingest.useMutation({
    onSuccess: async () => {
      await refreshMap();
    },
  });

  async function refreshMap(): Promise<void> {
    await Promise.all([
      utils.report.byBounds.invalidate(),
      utils.stats.summary.invalidate(),
      utils.scan.recent.invalidate(),
    ]);
  }

  // Asked once per mount: whether this deployment can scan a recording at all.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/scan/worker');
        const body = (await response.json()) as WorkerStatus;
        if (!cancelled) setWorker(body);
      } catch {
        if (!cancelled) {
          setWorker({
            available: false,
            reason: 'Could not reach this deployment to ask whether it can scan recordings.',
            maxUploadBytes: 0,
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const readPayloadFile = async (file: File) => {
    setParseError(null);
    setPayload(null);
    setFileName(file.name);
    ingest.reset();

    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      setParseError('That file is not JSON. Export it with `--format map`.');
      return;
    }

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

  /** Send the recording itself; only reachable when a worker is available. */
  const scanRawFiles = async (files: File[]) => {
    setRawBusy(true);
    setRawError(null);
    setRawOutcome(null);
    try {
      const form = new FormData();
      for (const file of files) form.append('file', file, relativePathOf(file) ?? file.name);
      form.append('recording', recordingLabelForFiles(files.map(toDescriptor)));

      const response = await fetch('/api/scan/raw', { method: 'POST', body: form });
      const body = (await response.json().catch(() => null)) as RawScanOutcome | null;
      if (response.ok && body?.status === 'scanned') {
        setRawOutcome(body);
        await refreshMap();
        return;
      }
      // 503 is the honest answer of a deployment without a worker: fall back to
      // the printed command rather than leaving the upload looking broken.
      if (response.status === 503 && body?.reason) {
        setWorker((current) =>
          current ? { ...current, available: false, reason: body.reason ?? current.reason } : current,
        );
        setRawOutcome(body);
        return;
      }
      setRawError(
        body?.reason ??
          `The scan worker could not scan that recording (HTTP ${response.status}). Run the ` +
            'command below locally and upload the JSON instead.',
      );
    } catch (error) {
      setRawError(
        error instanceof Error
          ? `Upload failed: ${error.message}`
          : 'Upload failed before the recording reached the worker.',
      );
    } finally {
      setRawBusy(false);
    }
  };

  const pickRecording = (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (!files.length) return;
    setRecording(recordingLabelForFiles(files.map(toDescriptor)));
    setRawOutcome(null);
    setRawError(null);
    if (worker?.available) void scanRawFiles(files);
  };

  const quality = payload?.quality;
  const result = ingest.data;
  const command = scanCliCommand({ recording: recording ?? 'recording.zip' });

  return (
    <div className="card">
      <h2>Import a scan</h2>
      <p className="muted">
        Walk a street with the phone recording, then bring either the raw export from the phone or
        the JSON the bridge CLI writes: each floor imperfection becomes a rough-surface report.
      </p>

      <span className="field-label" id="scan-raw-label">
        Raw phone recording (.zip or exported folder)
      </span>
      <p className="muted" role="status">
        {worker === null
          ? 'Checking whether this deployment can scan recordings…'
          : worker.available
            ? 'This deployment has a scan worker: the recording is scanned here, no laptop step.'
            : (worker.reason ?? 'No scan worker on this deployment.')}
      </p>
      <input
        id="scan-raw-file"
        aria-labelledby="scan-raw-label"
        type="file"
        accept=".zip,application/zip"
        onChange={(event) => pickRecording(event.target.files)}
      />
      <label htmlFor="scan-raw-dir">…or the unzipped export folder</label>
      <input
        id="scan-raw-dir"
        type="file"
        multiple
        // Directory picking is a Chrome/Safari/Edge attribute React does not
        // type; a browser without it simply shows a multi-file picker.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => pickRecording(event.target.files)}
      />

      {rawBusy ? (
        <p className="muted" role="status">
          Scanning {recording} on the server…
        </p>
      ) : null}

      {rawOutcome?.status === 'scanned' ? (
        <p role="status">
          {rawOutcome.accepted
            ? `Scanned ${recording}: ${rawOutcome.reportCount ?? 0} rough-surface ${
                (rawOutcome.reportCount ?? 0) === 1 ? 'report' : 'reports'
              } on the map.`
            : `Scanned ${recording}, but the capture was unusable — no reports were created.`}
        </p>
      ) : null}

      {rawError ? (
        <p className="error" role="alert">
          {rawError}
        </p>
      ) : null}

      {recording && !worker?.available ? (
        <div className="scan-fallback">
          <p className="muted">
            Nothing was scanned. Run this where the recording is, then upload the{' '}
            <code>scan.json</code> it writes:
          </p>
          <pre className="scan-command">
            <code>{command}</code>
          </pre>
        </div>
      ) : null}

      <label htmlFor="scan-file">Scan payload from the CLI (JSON)</label>
      <input
        id="scan-file"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (isRawExportFileName(file.name)) {
            setParseError('That is a raw recording — use the recording field above.');
            return;
          }
          void readPayloadFile(file);
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
                  {captureVerdictLabel(scan.verdict) ?? scan.verdict}
                </span>
              </div>
              <div className="muted">
                {scan.reportCount} of {scan.findingCount} findings mapped ·{' '}
                {scan.cadenceSpm.toFixed(0)} spm
              </div>
              <button
                type="button"
                className="chip"
                aria-expanded={openScanId === scan.id}
                aria-controls={`scan-detail-${scan.id}`}
                onClick={() => setOpenScanId((current) => (current === scan.id ? null : scan.id))}
              >
                {openScanId === scan.id ? 'Hide capture settings' : 'Capture settings'}
              </button>
              {openScanId === scan.id ? <ScanDetail scanId={scan.id} /> : null}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function toDescriptor(file: File): { name: string; relativePath: string | null } {
  return { name: file.name, relativePath: relativePathOf(file) };
}
