'use client';

import { api } from '@/trpc/client';

export function StatsPanel() {
  const stats = api.stats.summary.useQuery();
  if (!stats.data) return null;

  return (
    <div className="card">
      <strong>Coverage</strong>
      <p className="muted">
        {stats.data.reports} active reports · {(stats.data.surveyedMeters / 1000).toFixed(1)} km
        surveyed across {stats.data.traceCount} traces
      </p>
      <strong>Top contributors</strong>
      {stats.data.topContributors.map((contributor) => (
        <div className="muted" key={contributor.handle}>
          {contributor.displayName ?? contributor.handle} — {contributor.points} pts
        </div>
      ))}
    </div>
  );
}
