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

interface ReportFormProps {
  pin: { lat: number; lng: number } | null;
  profile: Profile;
  onDone: () => void;
}

/** One-tap-ish capture: pick a spot on the map (or use GPS), choose a kind, send. */
export function ReportForm({ pin, profile, onDone }: ReportFormProps) {
  const utils = api.useUtils();
  const [kind, setKind] = useState<ObstacleKind>('CURB');
  const [passability, setPassability] = useState<Passability>('DIFFICULT');
  const [heightCm, setHeightCm] = useState('');
  const [note, setNote] = useState('');
  const [gps, setGps] = useState<{ lat: number; lng: number; accuracyM?: number } | null>(null);

  const create = api.report.create.useMutation({
    onSuccess: async () => {
      await utils.report.byBounds.invalidate();
      await utils.stats.summary.invalidate();
      setNote('');
      setHeightCm('');
      setGps(null);
      onDone();
    },
  });

  const target = pin ?? gps;

  const useMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) =>
      setGps({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracyM: position.coords.accuracy,
      }),
    );
  };

  return (
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        if (!target) return;
        create.mutate({
          lat: target.lat,
          lng: target.lng,
          kind,
          passability,
          heightCm: heightCm ? Number(heightCm) : undefined,
          note: note || undefined,
          capturedByProfile: profile,
          accuracyM: gps?.accuracyM,
          clientReportId: crypto.randomUUID(),
        });
      }}
    >
      <strong>Report what you just passed</strong>
      <p className="muted">
        {target
          ? `at ${target.lat.toFixed(5)}, ${target.lng.toFixed(5)}`
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
        min={0}
        max={200}
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
        <button type="button" onClick={useMyLocation}>
          Use my location
        </button>
        <button className="primary" type="submit" disabled={!target || create.isPending}>
          {create.isPending ? 'Sending…' : 'Send report'}
        </button>
      </div>
      {create.error ? <p className="muted">{create.error.message}</p> : null}
    </form>
  );
}
