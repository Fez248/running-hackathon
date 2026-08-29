'use client';

import { useState } from 'react';
import {
  OBSTACLE_LABELS,
  VOICE_METER_BARS,
  meterBars,
  type LocationPermissionState,
  type ObstacleKind,
} from '@sidewalk/core';
import type { RunStatus } from '@/hooks/use-run-tracker';
import type { MicrophoneState, VoiceUtterance } from '@/hooks/use-voice-reporter';

interface RunPanelProps {
  status: RunStatus;
  distanceM: number;
  revealedCells: number;
  fogEnabled: boolean;
  onToggleFog: (enabled: boolean) => void;
  follow: boolean;
  onToggleFollow: (follow: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  /** Blocks the start button when the browser will refuse to track at all. */
  locationState: LocationPermissionState;
  /** A prompt is already open: a second Start would race its own run. */
  locationRequesting: boolean;
  voice: {
    enabled: boolean;
    supported: boolean;
    micState: MicrophoneState;
    listening: boolean;
    starting: boolean;
    /** Live microphone level, 0..1, for the input meter. */
    level: number;
    interim: string;
    error: string | null;
    utterances: VoiceUtterance[];
  };
  onToggleVoice: (enabled: boolean) => void;
  onCancelPhrase: () => void;
  onRetryMic: () => void;
  onTypedReport: (text: string) => void;
  voiceStatus: string | null;
  /** Coverage query failure: the fog is stale, which is otherwise invisible. */
  fogError?: string | null;
}

const REJECTION_LABELS: Record<string, string> = {
  inaccurate: 'last fix ignored (accuracy too poor)',
  'implausible-speed': 'last fix ignored (GPS jump)',
  'too-close': 'holding position',
};

/** Run controls: precise GPS, fog reveal and ambient voice reporting. */
export function RunPanel({
  status,
  distanceM,
  revealedCells,
  fogEnabled,
  onToggleFog,
  follow,
  onToggleFollow,
  onStart,
  onStop,
  locationState,
  locationRequesting,
  voice,
  onToggleVoice,
  onCancelPhrase,
  onRetryMic,
  onTypedReport,
  voiceStatus,
  fogError = null,
}: RunPanelProps) {
  const [typed, setTyped] = useState('');
  const micBlocked = voice.micState === 'denied' || voice.micState === 'unavailable';
  const bars = meterBars(voice.level);
  const voiceStateLabel = voice.starting
    ? '· opening microphone'
    : voice.listening
      ? '· listening'
      : micBlocked
        ? '· microphone blocked'
        : '';
  const locationBlocked = locationState === 'denied' || locationState === 'unavailable';

  return (
    <div className="card">
      <h2>Fog of War run</h2>
      <p className="muted">
        Precise GPS clears the fog around your path; dictate what you pass and it lands on the map
        at your current position.
      </p>

      <div className="row">
        {status.active ? (
          <button type="button" onClick={onStop}>
            Stop run
          </button>
        ) : (
          <button
            className="primary"
            type="button"
            onClick={onStart}
            disabled={locationBlocked || locationRequesting}
          >
            {locationRequesting
              ? 'Waiting for location access…'
              : locationState === 'granted'
                ? 'Start run'
                : 'Start run (asks for location)'}
          </button>
        )}
        <span className="badge" data-gps={status.quality} role="status">
          {status.active
            ? `${status.quality} · ${status.accuracyM ? `±${status.accuracyM.toFixed(0)} m` : 'waiting for fix'}`
            : 'GPS off'}
        </span>
      </div>

      <p className="muted" aria-live="polite">
        {(distanceM / 1000).toFixed(2)} km tracked · {status.fixes} fixes kept · {revealedCells}{' '}
        cells cleared
        {status.active && status.lastRejection
          ? ` · ${REJECTION_LABELS[status.lastRejection] ?? status.lastRejection}`
          : ''}
      </p>
      {locationBlocked && !status.active ? (
        <p className="muted">
          Location access is off, so a run cannot start — see the location panel above.
        </p>
      ) : null}
      {status.error ? (
        <p className="error" role="alert">
          {status.error}
        </p>
      ) : null}
      {fogError ? (
        <p className="error" role="alert">
          Could not load revealed coverage — the fog may be out of date. {fogError}
        </p>
      ) : null}

      <label className="toggle">
        <input
          type="checkbox"
          checked={fogEnabled}
          onChange={(event) => onToggleFog(event.target.checked)}
        />
        Show Fog of War overlay
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={follow}
          onChange={(event) => onToggleFollow(event.target.checked)}
        />
        Keep the map centred on me
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={voice.enabled}
          disabled={!voice.supported || !status.active || micBlocked || voice.starting}
          onChange={(event) => void onToggleVoice(event.target.checked)}
        />
        Ambient voice reporting {voiceStateLabel}
      </label>

      {voice.listening ? (
        <div className="voice-live">
          <div className="meter" aria-hidden="true">
            {Array.from({ length: VOICE_METER_BARS }, (_, index) => (
              <span key={index} className="bar" data-on={index < bars ? '' : undefined} />
            ))}
          </div>
          <span className="muted">{bars === 0 ? 'mic open, nothing heard' : 'hearing you'}</span>
          <button type="button" onClick={onCancelPhrase}>
            Discard phrase
          </button>
        </div>
      ) : null}

      <p className="muted">
        {!voice.supported
          ? 'This browser has no Web Speech API (Firefox ships it disabled) — type the report instead.'
          : micBlocked
            ? 'Dictation needs the microphone. Chrome: click the icon left of the address bar → Site settings → Microphone → Allow, then re-check below.'
            : status.active
              ? 'Audio is only captured while this is on, and the microphone is released the moment you switch it off. Recognition runs in your browser’s speech service; only the transcript and your coordinate are stored.'
              : 'Start a run to dictate reports — an utterance is placed at your latest accepted GPS fix.'}
      </p>
      {voice.interim ? <p className="interim">“{voice.interim}”</p> : null}
      {voice.error ? (
        <p className="error" role="alert">
          {voice.error}
        </p>
      ) : null}
      {micBlocked ? (
        <button type="button" onClick={onRetryMic}>
          Re-check microphone
        </button>
      ) : null}
      <p className="muted live-status" role="status">
        {voiceStatus}
      </p>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!typed.trim()) return;
          onTypedReport(typed.trim());
          setTyped('');
        }}
      >
        <input
          aria-label="Type a report"
          placeholder={status.active ? 'e.g. high curb about 15 cm' : 'Start a run to log a report here'}
          value={typed}
          disabled={!status.active}
          onChange={(event) => setTyped(event.target.value)}
        />
        <button type="submit" disabled={!status.active || !typed.trim()}>
          Log
        </button>
      </form>

      {voice.utterances.length ? (
        <div className="utterances">
          <h3>Logged this run</h3>
          {voice.utterances.map((utterance) => (
            <div className="report" key={utterance.id}>
              <div>“{utterance.transcript}”</div>
              {utterance.parsed ? (
                <div className="muted">
                  → {OBSTACLE_LABELS[utterance.parsed.kind as ObstacleKind]} ·{' '}
                  {utterance.parsed.passability.toLowerCase()}
                  {utterance.parsed.heightCm != null ? ` · ${utterance.parsed.heightCm} cm` : ''}
                </div>
              ) : (
                <div className="row">
                  <span className="muted">→ no sidewalk feature recognised</span>
                  <button type="button" onClick={() => setTyped(utterance.transcript)}>
                    Edit and retry
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
