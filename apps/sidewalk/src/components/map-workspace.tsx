'use client';

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import {
  OBSTACLE_KINDS,
  OBSTACLE_LABELS,
  PROFILES,
  type ObstacleKind,
  type Profile,
} from '@sidewalk/core';
import { api } from '@/trpc/client';
import { ReportForm } from './report-form';
import { StatsPanel } from './stats-panel';

const MapView = dynamic(() => import('./map-view').then((m) => m.MapView), {
  ssr: false,
  loading: () => <div className="map-wrap" />,
});

/** Berlin Mitte — matches the seed data. */
const DEFAULT_CENTER = { lat: 52.5208, lng: 13.4095 };

export interface Viewport {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * The single place a report will be filed. Coordinates and accuracy always come
 * from the same source, so a map tap never inherits a stale GPS accuracy.
 */
export interface Selection {
  lat: number;
  lng: number;
  source: 'map' | 'gps';
  accuracyM?: number;
}

const DEFAULT_VIEWPORT: Viewport = {
  minLat: DEFAULT_CENTER.lat - 0.02,
  maxLat: DEFAULT_CENTER.lat + 0.02,
  minLng: DEFAULT_CENTER.lng - 0.03,
  maxLng: DEFAULT_CENTER.lng + 0.03,
};

export function MapWorkspace() {
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [profile, setProfile] = useState<Profile>('WHEELCHAIR');
  const [kinds, setKinds] = useState<ObstacleKind[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);

  const reports = api.report.byBounds.useQuery({
    ...viewport,
    profile,
    kinds: kinds.length ? kinds : undefined,
    limit: 500,
  });

  const toggleKind = (kind: ObstacleKind) =>
    setKinds((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );

  const markers = useMemo(() => reports.data ?? [], [reports.data]);

  return (
    <main className="layout">
      <MapView
        center={DEFAULT_CENTER}
        reports={markers}
        selection={selection}
        onPick={(coord) => setSelection({ ...coord, source: 'map' })}
        onViewportChange={setViewport}
      />

      <aside className="sidebar">
        <h1>Sidewalk Map</h1>
        <p className="tagline">
          Curbs, steps, roadworks and passable crossings — crowdsourced by runners and riders while
          they move.
        </p>

        <div className="card">
          <label htmlFor="profile">I travel as</label>
          <select
            id="profile"
            value={profile}
            onChange={(event) => setProfile(event.target.value as Profile)}
          >
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p.replace('_', ' ').toLowerCase()}
              </option>
            ))}
          </select>

          <label>Filter features</label>
          <div className="chips">
            {OBSTACLE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="chip"
                data-active={kinds.includes(kind)}
                onClick={() => toggleKind(kind)}
              >
                {OBSTACLE_LABELS[kind]}
              </button>
            ))}
          </div>
        </div>

        <ReportForm
          selection={selection}
          profile={profile}
          onSelect={setSelection}
          onDone={() => setSelection(null)}
        />

        <div className="card">
          <strong>
            {reports.isPending ? 'Loading reports…' : `${markers.length} reports in view`}
          </strong>
          {reports.error ? <p className="muted">{reports.error.message}</p> : null}
          {markers.map((report) => (
            <div className="report" key={report.id}>
              <div>
                {OBSTACLE_LABELS[report.kind as ObstacleKind] ?? report.kind}
                <span className="badge" data-p={report.effectivePassability}>
                  {report.effectivePassability.toLowerCase()}
                </span>
              </div>
              {report.note ? <div className="muted">{report.note}</div> : null}
              <div className="muted">
                confidence {(report.confidence * 100).toFixed(0)}% · +{report.agreeCount}/-
                {report.disagreeCount}
              </div>
            </div>
          ))}
        </div>

        <StatsPanel />
      </aside>
    </main>
  );
}
