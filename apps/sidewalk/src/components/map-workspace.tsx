'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_REVEAL_RADIUS_M,
  OBSTACLE_KINDS,
  OBSTACLE_LABELS,
  PROFILES,
  reportProvenanceLine,
  reportSourceMark,
  type ObstacleKind,
  type Profile,
} from '@sidewalk/core';
import { api } from '@/trpc/client';
import { useLocationPermission } from '@/hooks/use-location-permission';
import { useRunTracker } from '@/hooks/use-run-tracker';
import { useVoiceReporter } from '@/hooks/use-voice-reporter';
import { LocationConsentPanel } from './location-consent-panel';
import { ReportForm } from './report-form';
import { RunPanel } from './run-panel';
import { ScanPanel } from './scan-panel';
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
  const locationPermission = useLocationPermission();

  const runTracker = useRunTracker({
    revealRadiusM: DEFAULT_REVEAL_RADIUS_M,
    onRevealed: () => {
      void utils.coverage.byBounds.invalidate();
      void utils.coverage.summary.invalidate();
    },
  });
  const running = runTracker.status.active;

  /**
   * Consent first, watch second: `watchPosition` would raise the prompt itself,
   * but then the explanation of *why* arrives after the browser has already
   * asked, and a denial reads as a broken button. Permission granted in the same
   * gesture still counts, so the watch starts without a second tap.
   */
  const handleStart = useCallback(async () => {
    if (locationPermission.state === 'granted') {
      runTracker.start();
      return;
    }
    const state = await locationPermission.request();
    if (state === 'granted') runTracker.start();
  }, [locationPermission, runTracker]);

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
  const traceIdRef = useRef(runTracker.traceId);
  traceIdRef.current = runTracker.traceId;
  const runningRef = useRef(running);
  runningRef.current = running;

  const createFromVoice = api.report.createFromVoice.useMutation({
    onSuccess: (result) => {
      if (result.ignored) return;
      const where = result.report
        ? `${result.report.lat.toFixed(5)}, ${result.report.lng.toFixed(5)}`
        : null;
      setVoiceStatus(
        result.report
          ? result.pendingReview
            ? // Tell the reporter their words were kept even though the map has
              // not changed, so a queued report does not read as a lost one.
              `Heard “${result.report.transcript ?? ''}” at ${where} but only half understood it — held for review.`
            : `Logged “${result.report.note ?? ''}” at ${where}`
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
      const position = runningRef.current ? positionRef.current : null;
      if (!position) {
        // Refusing a stale fix: after a run ends the last position is history, not
        // where the reporter is standing.
        setVoiceStatus('Heard a report but there is no live GPS fix — start a run first.');
        return;
      }
      createFromVoiceRef.current.mutate({
        transcript: utterance.transcript,
        lat: position.lat,
        lng: position.lng,
        accuracyM: position.accuracyM ?? undefined,
        recognitionConfidence: utterance.recognitionConfidence ?? undefined,
        capturedByProfile: profile,
        traceId: traceIdRef.current ?? undefined,
        clientReportId: utterance.id,
      });
    },
  });

  const toggleVoice = useCallback(
    async (enabled: boolean) => {
      if (!enabled) {
        setVoiceEnabled(false);
        voice.stopRecognition();
        return;
      }
      setVoiceEnabled(true);
      // A refused microphone must not leave the toggle looking armed.
      const started = await voice.startRecognition();
      if (!started) setVoiceEnabled(false);
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

  // The session can also give up on its own (permission revoked mid-run, the
  // recogniser dropping out repeatedly).
  useEffect(() => {
    if (voiceEnabled && !voice.listening && !voice.starting) setVoiceEnabled(false);
  }, [voiceEnabled, voice.listening, voice.starting]);

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

        <LocationConsentPanel permission={locationPermission} runActive={running} />

        <RunPanel
          status={runTracker.status}
          distanceM={runTracker.status.distanceM}
          revealedCells={runTracker.localBounds.length}
          fogEnabled={fogEnabled}
          onToggleFog={setFogEnabled}
          follow={follow}
          onToggleFollow={setFollow}
          onStart={() => void handleStart()}
          locationState={locationPermission.state}
          onStop={() => void runTracker.stop()}
          voice={{
            enabled: voiceEnabled,
            supported: voice.supported,
            micState: voice.micState,
            listening: voice.listening,
            starting: voice.starting,
            level: voice.level,
            interim: voice.interim,
            error: voice.error,
            utterances: voice.utterances,
          }}
          onToggleVoice={toggleVoice}
          onCancelPhrase={voice.cancelPhrase}
          onRetryMic={voice.retryMic}
          onTypedReport={voice.submitTyped}
          voiceStatus={voiceStatus}
          fogError={coverage.error?.message ?? null}
        />

        <div className="card">
          <h2>Filters</h2>
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

          <span className="field-label" id="kind-filter-label">
            Filter features
          </span>
          <div className="chips" role="group" aria-labelledby="kind-filter-label">
            {OBSTACLE_KINDS.map((kind) => (
              <button
                key={kind}
                type="button"
                className="chip"
                data-active={kinds.includes(kind)}
                aria-pressed={kinds.includes(kind)}
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
          <h2>Reports in view</h2>
          <p className="muted" role="status">
            {reports.isPending
              ? 'Loading reports…'
              : `${markers.length} ${markers.length === 1 ? 'report' : 'reports'} in view`}
          </p>
          {reports.error ? (
            <p className="error" role="alert">
              {reports.error.message}
            </p>
          ) : null}
          {!reports.isPending && !reports.error && !markers.length ? (
            <p className="muted">
              Nothing mapped here yet — tap the map to place a report, or pan to another street.
            </p>
          ) : null}
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
              <div className="source-tag" data-source={reportSourceMark(report.source).source}>
                <span aria-hidden="true">{reportSourceMark(report.source).glyph}</span>{' '}
                {reportProvenanceLine(report)}
              </div>
            </div>
          ))}
        </div>

        <ScanPanel />

        <StatsPanel />
      </aside>
    </main>
  );
}
