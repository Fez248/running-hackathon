'use client';

import { api } from '@/trpc/client';

export function StatsPanel() {
  const stats = api.stats.summary.useQuery();

  return (
    <div className="card">
      <h2>City progress</h2>
      {stats.error ? (
        <p className="error" role="alert">
          {stats.error.message}
        </p>
      ) : null}
      {stats.data ? (
        <>
          <p className="muted">
            {stats.data.reports} obstacles mapped · {(stats.data.surveyedMeters / 1000).toFixed(1)}{' '}
            km cleared across {stats.data.traceCount} routes
          </p>
          {stats.data.topContributors.length ? (
            <>
              <h3>Top contributors</h3>
              {stats.data.topContributors.map((contributor) => (
                <div className="muted" key={contributor.handle}>
                  {contributor.displayName ?? contributor.handle} — {contributor.points} pts
                </div>
              ))}
            </>
          ) : null}
        </>
      ) : stats.error ? null : (
        <p className="muted">Loading…</p>
      )}
    </div>
  );
}
