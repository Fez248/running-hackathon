'use client';

import { useState } from 'react';
import { OBSTACLE_LABELS, type ObstacleKind } from '@sidewalk/core';
import type { RunStatus } from '@/hooks/use-run-tracker';
import type { VoiceUtterance } from '@/hooks/use-voice-reporter';

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
  voice: {
    enabled: boolean;
    supported: boolean;
    listening: boolean;
    interim: string;
    error: string | null;
    utterances: VoiceUtterance[];
  };
  onToggleVoice: (enabled: boolean) => void;
  onTypedReport: (text: string) => void;
  voiceStatus: string | null;
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
  voice,
  onToggleVoice,
  onTypedReport,
  voiceStatus,
}: RunPanelProps) {
  const [typed, setTyped] = useState('');

  return (
    <div className="card">
      <strong>Fog of War run</strong>
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
          <button className="primary" type="button" onClick={onStart}>
            Start run
          </button>
        )}
        <span className="badge" data-gps={status.quality}>
          {status.active
            ? `${status.quality} · ${status.accuracyM ? `±${status.accuracyM.toFixed(0)} m` : 'waiting for fix'}`
            : 'GPS off'}
        </span>
      </div>

      <p className="muted">
        {(distanceM / 1000).toFixed(2)} km tracked · {status.fixes} fixes kept · {revealedCells}{' '}
        cells cleared
        {status.active && status.lastRejection
          ? ` · ${REJECTION_LABELS[status.lastRejection] ?? status.lastRejection}`
          : ''}
      </p>
      {status.error ? <p className="error">{status.error}</p> : null}

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
          disabled={!voice.supported}
          onChange={(event) => onToggleVoice(event.target.checked)}
        />
        Ambient voice reporting {voice.listening ? '· listening' : ''}
      </label>

      <p className="muted">
        {voice.supported
          ? 'Audio is only captured while this is on. Recognition runs in your browser’s speech service; only the transcript and your coordinate are stored.'
          : 'This browser has no Web Speech API (Firefox ships it disabled) — type the report instead.'}
      </p>
      {voice.interim ? <p className="interim">“{voice.interim}”</p> : null}
      {voice.error ? <p className="error">{voice.error}</p> : null}
      {voiceStatus ? <p className="muted">{voiceStatus}</p> : null}

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
          aria-label="Dictate or type a report"
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
                <div className="muted">→ no sidewalk feature recognised, ignored</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
