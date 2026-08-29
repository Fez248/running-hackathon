import { describe, expect, it } from 'vitest';
import {
  isRawExportFileName,
  isScanPayloadFileName,
  recordingLabelForFiles,
  scanCliCommand,
  shellQuote,
} from './scan-upload';

describe('picked file classification', () => {
  it('separates raw recordings from scan payloads', () => {
    expect(isRawExportFileName('2026-08-29 14-05-11.ZIP')).toBe(true);
    expect(isRawExportFileName('scan.json')).toBe(false);
    expect(isScanPayloadFileName('scan.JSON')).toBe(true);
    expect(isScanPayloadFileName('export.zip')).toBe(false);
  });
});

describe('shellQuote', () => {
  it('leaves a plain name alone and quotes anything a shell would misread', () => {
    expect(shellQuote('recording.zip')).toBe('recording.zip');
    expect(shellQuote('2026-08-29 14-05-11.zip')).toBe("'2026-08-29 14-05-11.zip'");
    expect(shellQuote('')).toBe("''");
  });

  it('survives a quote in the name', () => {
    expect(shellQuote("sergi's walk.zip")).toBe("'sergi'\\''s walk.zip'");
  });
});

describe('scanCliCommand', () => {
  it('fills in the picked recording and runs the repository way', () => {
    expect(scanCliCommand({ recording: 'walk.zip' })).toBe(
      'cd apps/bridge && uv run python -m bridge.cli scan walk.zip --format map --out scan.json',
    );
  });

  it('quotes an exported name with spaces so the command is runnable as printed', () => {
    expect(scanCliCommand({ recording: '2026-08-29 14-05-11', out: 'out file.json' })).toBe(
      "cd apps/bridge && uv run python -m bridge.cli scan '2026-08-29 14-05-11' " +
        "--format map --out 'out file.json'",
    );
  });

  it('names something rather than nothing when no file is picked yet', () => {
    expect(scanCliCommand({ recording: '' })).toContain('recording.zip');
  });
});

describe('recordingLabelForFiles', () => {
  it('uses the file name for a single archive', () => {
    expect(recordingLabelForFiles([{ name: 'walk.zip' }])).toBe('walk.zip');
  });

  it('uses the directory for a directory pick', () => {
    expect(
      recordingLabelForFiles([
        { name: 'Accelerometer.csv', relativePath: '2026-08-29 14-05-11/Accelerometer.csv' },
        { name: 'Gravity.csv', relativePath: '2026-08-29 14-05-11/Gravity.csv' },
      ]),
    ).toBe('2026-08-29 14-05-11');
  });

  it('is empty with nothing picked', () => {
    expect(recordingLabelForFiles([])).toBe('');
  });
});
