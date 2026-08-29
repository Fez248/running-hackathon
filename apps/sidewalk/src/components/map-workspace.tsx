'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REVEAL_RADIUS_M,
  OBSTACLE_KINDS,
  OBSTACLE_LABELS,
  PROFILES,
  type ObstacleKind,
  type Profile,
} from '@sidewalk/core';
import { api } from '@/trpc/client';
import { useRunTracker } from '@/hooks/use-run-tracker';
import { useVoiceReporter } from '@/hooks/use-voice-reporter';
import { ReportForm } from './report-form';
import { RunPanel } from './run-panel';
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

/** While a run is active, reports and fog refresh on this interval. */
const LIVE_REFETCH_MS = 4_000;

export function MapWorkspace() {
  const [viewport, setViewport] = useState<Viewport>(DEFAULT_VIEWPORT);
  const [profile, setProfile] = useState<Profile>('WHEELCHAIR');
  const [kinds, setKinds] = useState<ObstacleKind[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [fogEnabled, setFogEnabled] = useState(true);
  const [follow, setFollow] = useState(true);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);

  const utils = api.useUtils();

  const runTracker = useRunTracker({
    revealRadiusM: DEFAULT_REVEAL_RADIUS_M,
    onRevealed: () => {
      void utils.coverage.byBounds.invalidate();
      void utils.coverage.summary.invalidate();
    },
  });
  const running = runTracker.status.active;

  const reports = api.report.byBounds.useQuery(
    {
      ...viewport,
      profile,
      kinds: kinds.length ? kinds : undefined,
      limit: 500,
    },
    { refetchInterval: running ? LIVE_REFETCH_MS : false },
  );

  const coverage = api.coverage.byBounds.useQuery(
    { ...viewport, limit: 8_000 },
    { refetchInterval: running ? LIVE_REFETCH_MS : false },
  );

  /** Voice reports are geocoded to the latest accepted GPS fix. */
  const positionRef = useRef(runTracker.position);
  positionRef.current = runTracker.position;

  const createFromVoice = api.report.createFromVoice.useMutation({
    onSuccess: (result) => {
      if (result.ignored) return;
      setVoiceStatus(
        result.report
          ? `Logged “${result.report.note ?? ''}” at ${result.report.lat.toFixed(5)}, ${result.report.lng.toFixed(5)}`
          : null,
      );
      void utils.report.byBounds.invalidate();
      void utils.stats.summary.invalidate();
    },
    onError: (error) => setVoiceStatus(error.message),
  });
  const createFromVoiceRef = useRef(createFromVoice);
  createFromVoiceRef.current = createFromVoice;

  const voice = useVoiceReporter({
    onReport: (utterance) => {
      const position = positionRef.current;
      if (!position) {
        setVoiceStatus('Heard a report but there is no GPS fix yet — start a run first.');
        return;
      }
      createFromVoiceRef.current.mutate({
        transcript: utterance.transcript,
        lat: position.lat,
        lng: position.lng,
        accuracyM: position.accuracyM ?? undefined,
        recognitionConfidence: utterance.recognitionConfidence ?? undefined,
        capturedByProfile: profile,
        clientReportId: utterance.id,
      });
    },
  });

  const toggleVoice = useCallback(
    (enabled: boolean) => {
      setVoiceEnabled(enabled);
      if (enabled) voice.startRecognition();
      else voice.stopRecognition();
    },
    [voice],
  );

  // Dictation is tied to the run: stopping the run also stops the microphone.
  useEffect(() => {
    if (!running && voiceEnabled) {
      setVoiceEnabled(false);
      voice.stopRecognition();
    }
  }, [running, voiceEnabled, voice]);

  const toggleKind = (kind: ObstacleKind) =>
    setKinds((current) =>
      current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind],
    );

  const markers = useMemo(() => reports.data ?? [], [reports.data]);
  const fogCells = useMemo(() => coverage.data ?? [], [coverage.data]);
  const liveHole = runTracker.position
    ? {
        lat: runTracker.position.lat,
        lng: runTracker.position.lng,
        radiusM: runTracker.revealRadiusM,
      }
    : null;

  return (
    <main className="layout">
      <MapView
        center={DEFAULT_CENTER}
        reports={markers}
        selection={selection}
        onPick={(coord) => setSelection({ ...coord, source: 'map' })}
        onViewportChange={setViewport}
        fog={{
          enabled: fogEnabled,
          cells: fogCells,
          pendingBounds: runTracker.localBounds,
          liveHole,
        }}
        runPath={runTracker.path}
        livePosition={runTracker.position}
        follow={follow && running}
      />

      <aside className="sidebar">
        <h1>Sidewalk Map</h1>
        <p className="tagline">
          Curbs, steps, roadworks and passable crossings — crowdsourced by runners and riders while
          they move. Streets you have not surveyed stay under the fog.
        </p>

        <RunPanel
          status={runTracker.status}
          distanceM={runTracker.status.distanceM}
          revealedCells={runTracker.localBounds.length}
          fogEnabled={fogEnabled}
          onToggleFog={setFogEnabled}
          follow={follow}
          onToggleFollow={setFollow}
          onStart={runTracker.start}
          onStop={() => void runTracker.stop()}
          voice={{
            enabled: voiceEnabled,
            supported: voice.supported,
            listening: voice.listening,
            interim: voice.interim,
            error: voice.error,
            utterances: voice.utterances,
          }}
          onToggleVoice={toggleVoice}
          onTypedReport={voice.submitTyped}
          voiceStatus={voiceStatus}
        />

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
                {report.source === 'VOICE' ? ' · dictated' : ''}
              </div>
            </div>
          ))}
        </div>

        <StatsPanel />
      </aside>
    </main>
  );
}
