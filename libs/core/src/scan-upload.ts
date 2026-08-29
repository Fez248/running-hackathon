/**
 * The seam a *recording* arrives through, as opposed to the seam a finished
 * scan payload arrives through (`scanIngestSchema`).
 *
 * Recording on a phone and then scanning is five steps, four of them on a
 * laptop. The web app can remove three of them when a server-side scan worker
 * exists; when it does not, the honest thing is to hand the user the exact
 * command to run, with their own file name already in it, rather than to
 * pretend an upload did something. Both halves of that decision are here so
 * they can be tested without a browser.
 */

/** Raw Sensor Logger exports the app will forward to a scan worker. */
export const RAW_EXPORT_EXTENSIONS = ['.zip'] as const;

/** Whether a picked file looks like a raw recording archive rather than a payload. */
export function isRawExportFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return RAW_EXPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Whether a picked file looks like the CLI's `--format map` output. */
export function isScanPayloadFileName(name: string): boolean {
  return name.toLowerCase().endsWith('.json');
}

/**
 * A file or directory name a shell will not misread. Sensor Logger names its
 * exports with spaces and colons ("2026-08-29 14-05-11.zip"), and a command the
 * user must repair by hand is not a command.
 */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9._/@:+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ScanCliCommandOptions {
  /** Recording the user picked: an archive name or a directory name. */
  recording: string;
  /** Where the payload should be written; uploaded back into the scan panel. */
  out?: string;
}

/**
 * The command that turns a recording into an uploadable payload. This is the
 * fallback path, so it is written as the user will actually run it: under `uv`,
 * which is how this repository runs its Python.
 *
 * It deliberately does not `cd` into `apps/bridge` — `--project` puts the
 * command in the bridge's environment without moving the directory the
 * recording path is resolved from, since the browser only tells us the file's
 * bare name and a recording usually sits somewhere else entirely.
 */
export function scanCliCommand({ recording, out = 'scan.json' }: ScanCliCommandOptions): string {
  const target = shellQuote(recording || 'recording.zip');
  return `uv run --project apps/bridge python -m bridge.cli scan ${target} --format map --out ${shellQuote(out)}`;
}

/**
 * The recording a set of picked files represents. A directory input yields every
 * file inside it, and what the user (and the CLI) call the recording is the
 * directory itself.
 */
export function recordingLabelForFiles(
  files: readonly { name: string; relativePath?: string | null }[],
): string {
  if (files.length === 0) return '';
  if (files.length === 1 && !files[0]?.relativePath?.includes('/')) return files[0]?.name ?? '';
  const first = files.find((file) => file.relativePath?.includes('/'));
  const root = first?.relativePath?.split('/')[0];
  return root || (files[0]?.name ?? '');
}
