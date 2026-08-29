'use client';

import { useState } from 'react';
import {
  OBSTACLE_KINDS,
  OBSTACLE_LABELS,
  PASSABILITY,
  type ObstacleKind,
  type Passability,
  type Profile,
} from '@sidewalk/core';
import { api } from '@/trpc/client';
import type { Selection } from './map-workspace';

interface ReportFormProps {
  /** Where the report will be filed: a map tap or a GPS fix, never a mix. */
  selection: Selection | null;
  profile: Profile;
  onSelect: (selection: Selection) => void;
  onDone: () => void;
}

/** One-tap-ish capture: pick a spot on the map (or use GPS), choose a kind, send. */
export function ReportForm({ selection, profile, onSelect, onDone }: ReportFormProps) {
  const utils = api.useUtils();
  const [kind, setKind] = useState<ObstacleKind>('CURB');
  const [passability, setPassability] = useState<Passability>('DIFFICULT');
  const [heightCm, setHeightCm] = useState('');
  const [note, setNote] = useState('');
  /**
   * Idempotency key for the draft, not for the attempt: retrying after a failed
   * or ambiguous response must reuse it so the server dedupes instead of
   * inserting a second report. It only rotates once a draft is accepted.
   */
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const [locateError, setLocateError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const create = api.report.create.useMutation({
    onSuccess: async () => {
      await utils.report.byBounds.invalidate();
      await utils.stats.summary.invalidate();
      setNote('');
      setHeightCm('');
      setDraftId(crypto.randomUUID());
      onDone();
    },
  });

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setLocateError('This browser has no Geolocation API — tap the map instead.');
      return;
    }
    setLocateError(null);
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        onSelect({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          source: 'gps',
          accuracyM: position.coords.accuracy,
        });
      },
      (error) => {
        setLocating(false);
        setLocateError(
          error.code === error.PERMISSION_DENIED
            ? 'Location permission denied — tap the map to place the report.'
            : error.message || 'Could not get a location fix — tap the map instead.',
        );
      },
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selection) return;
        create.mutate({
          lat: selection.lat,
          lng: selection.lng,
          kind,
          passability,
          // The schema takes whole centimetres, so a typed 12.5 would be rejected.
          heightCm: heightCm ? Math.round(Number(heightCm)) : undefined,
          note: note || undefined,
          capturedByProfile: profile,
          accuracyM: selection.accuracyM,
          clientReportId: draftId,
        });
      }}
    >
      <h2>Report what you just passed</h2>
      <p className="muted">
        {selection
          ? `at ${selection.lat.toFixed(5)}, ${selection.lng.toFixed(5)} (${
              selection.source === 'gps'
                ? `GPS ±${Math.round(selection.accuracyM ?? 0)} m`
                : 'map tap'
            })`
          : 'Tap the map or use your location'}
      </p>

      <label htmlFor="kind">Feature</label>
      <select
        id="kind"
        value={kind}
        onChange={(event) => setKind(event.target.value as ObstacleKind)}
      >
        {OBSTACLE_KINDS.map((k) => (
          <option key={k} value={k}>
            {OBSTACLE_LABELS[k]}
          </option>
        ))}
      </select>

      <label htmlFor="passability">Passability</label>
      <select
        id="passability"
        value={passability}
        onChange={(event) => setPassability(event.target.value as Passability)}
      >
        {PASSABILITY.map((p) => (
          <option key={p} value={p}>
            {p.toLowerCase()}
          </option>
        ))}
      </select>

      <label htmlFor="height">Curb / step height (cm, optional)</label>
      <input
        id="height"
        type="number"
        inputMode="decimal"
        min={0}
        max={200}
        // Decimals are accepted and rounded on submit; step=1 would make the
        // form itself refuse "7.5" before that.
        step="any"
        value={heightCm}
        onChange={(event) => setHeightCm(event.target.value)}
      />

      <label htmlFor="note">Note (optional)</label>
      <textarea
        id="note"
        rows={2}
        maxLength={280}
        value={note}
        onChange={(event) => setNote(event.target.value)}
      />

      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" onClick={useMyLocation} disabled={locating}>
          {locating ? 'Locating…' : 'Use my location'}
        </button>
        <button className="primary" type="submit" disabled={!selection || create.isPending}>
          {create.isPending ? 'Sending…' : 'Send report'}
        </button>
      </div>
      {locateError ? (
        <p className="error" role="alert">
          {locateError}
        </p>
      ) : null}
      {create.error ? (
        <p className="error" role="alert">
          {create.error.message}
        </p>
      ) : null}
    </form>
  );
}
