'use client';

import { LOCATION_CONSENT_MESSAGES } from '@sidewalk/core';
import type { LocationPermission } from '@/hooks/use-location-permission';

interface LocationConsentPanelProps {
  permission: LocationPermission;
  /** Hidden once a run is under way — the run panel then owns GPS status. */
  runActive: boolean;
}

/**
 * Explains what location access is used for and asks for it from a real button
 * press, which is the only context in which Chrome shows its prompt.
 *
 * Once denied the browser stops asking, so the panel switches to the site
 * settings path plus a re-check that reads the permission back without
 * prompting.
 */
export function LocationConsentPanel({ permission, runActive }: LocationConsentPanelProps) {
  const { state, requesting, error, canRequest, cooldownMs, observable } = permission;
  const cooldownSeconds = Math.ceil(cooldownMs / 1_000);

  if (state === 'granted' && runActive) return null;

  return (
    <div className="card" data-permission={state}>
      <h2>Location access</h2>

      <p className="muted">
        Your position is what clears the fog and pins each obstacle to the right corner of the
        street.
      </p>
      <p className="muted">
        Tracking only runs between <strong>Start Exploring</strong> and <strong>Finish</strong> —
        nothing is sent while you are just looking at the map.
      </p>

      <p className="muted" role="status">
        {LOCATION_CONSENT_MESSAGES[state]}
      </p>

      {state !== 'granted' && state !== 'unavailable' ? (
        <div className="row">
          <button
            className="primary"
            type="button"
            onClick={() => void permission.request()}
            disabled={!canRequest}
          >
            {requesting ? 'Waiting for the browser…' : 'Allow location access'}
          </button>
        </div>
      ) : null}

      {cooldownSeconds > 0 && state !== 'denied' ? (
        <p className="muted" role="status">
          No fix yet — you can try again in {cooldownSeconds}s.
        </p>
      ) : null}

      {state === 'denied' ? (
        <>
          <p className="muted">
            Chrome will not ask twice. To turn it back on: click the icon on the left of the address
            bar → <strong>Site settings</strong> → <strong>Location</strong> →{' '}
            <strong>Allow</strong>. Then use the button below — no reload needed.
          </p>
          <div className="row">
            <button type="button" onClick={() => void permission.recheck()}>
              {observable ? 'Re-check permission' : 'I changed it — ask again'}
            </button>
          </div>
          <p className="muted">
            Prefer not to share location? You can still browse the map, but mapping obstacles needs
            your position.
          </p>
        </>
      ) : null}

      {state === 'unavailable' ? (
        <p className="muted">
          Without the Geolocation API this build can only browse existing reports.
        </p>
      ) : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
