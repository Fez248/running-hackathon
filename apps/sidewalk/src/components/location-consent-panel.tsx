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
        A run only works with your position: the fog clears around where you actually go, and every
        report — dictated or typed — is filed at your latest GPS fix.
      </p>
      <ul className="muted reasons">
        <li>Clearing the Fog of War along your route.</li>
        <li>Placing the obstacles you report at the right corner of the street.</li>
        <li>Weighting a report’s confidence by the accuracy of the fix behind it.</li>
      </ul>
      <p className="muted">
        Tracking only runs between <strong>Start run</strong> and <strong>Stop run</strong>. Nothing
        is sent while you are just looking at the map, and this permission check throws its own fix
        away.
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
            Prefer not to share location? Reports can still be typed, but they need a live run, so
            the map stays read-only until access is granted.
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
