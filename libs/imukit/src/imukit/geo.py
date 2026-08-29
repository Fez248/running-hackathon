"""GPS helpers: distance-along-path and spatial binning."""

from __future__ import annotations

import numpy as np

from .types import GpsTrack

EARTH_R = 6371008.8


def haversine_m(lat1, lon1, lat2, lon2) -> np.ndarray:
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dphi = p2 - p1
    dlmb = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dphi / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dlmb / 2) ** 2
    return 2 * EARTH_R * np.arcsin(np.sqrt(a))


def smooth_track(track: GpsTrack, window_s: float = 5.0) -> GpsTrack:
    """Moving-average the fix positions before any distance computation.

    Summing raw fix-to-fix haversine distances integrates positional noise as a
    random walk and grossly over-estimates path length (with 3 m 1 Hz fixes the
    error is tens of percent), which would smear every window onto the wrong
    place along the route.
    """
    if track.t.size < 3 or window_s <= 0:
        return track
    dt = float(np.median(np.diff(track.t)))
    n = max(1, int(round(window_s / max(dt, 1e-6))))
    if n <= 1:
        return track
    kernel = np.ones(n) / n
    pad = n // 2

    def _smooth(x: np.ndarray) -> np.ndarray:
        xp = np.pad(x, (pad, pad), mode="edge")
        return np.convolve(xp, kernel, mode="same")[pad : pad + x.size]

    return GpsTrack(t=track.t, lat=_smooth(track.lat), lon=_smooth(track.lon), accuracy_m=track.accuracy_m)


def cumulative_distance(track: GpsTrack, smooth_s: float = 0.0) -> np.ndarray:
    """Along-path distance in metres at every GPS fix."""
    if track.t.size == 0:
        return np.zeros(0)
    if smooth_s > 0:
        track = smooth_track(track, smooth_s)
    steps = haversine_m(track.lat[:-1], track.lon[:-1], track.lat[1:], track.lon[1:])
    return np.concatenate([[0.0], np.cumsum(steps)])


def distance_at_times(track: GpsTrack, t: np.ndarray, smooth_s: float = 5.0) -> np.ndarray:
    """Interpolate along-path distance onto IMU timestamps."""
    d = cumulative_distance(track, smooth_s=smooth_s)
    return np.interp(np.asarray(t, dtype=float), track.t, d)


def position_at_distance(track: GpsTrack, distance_m, smooth_s: float = 5.0):
    """Inverse of :func:`cumulative_distance`: along-path metres -> (lat, lon).

    Used to put a detection, which the detector expresses in metres along the
    route, back onto the map.
    """
    smoothed = smooth_track(track, smooth_s) if smooth_s > 0 else track
    d = cumulative_distance(track, smooth_s=smooth_s)
    q = np.asarray(distance_m, dtype=float)
    return np.interp(q, d, smoothed.lat), np.interp(q, d, smoothed.lon)


def bin_index(distance_m: np.ndarray, bin_size_m: float) -> np.ndarray:
    return np.floor(np.asarray(distance_m, dtype=float) / bin_size_m).astype(int)


def aggregate_by_bin(
    distance_m: np.ndarray,
    values: np.ndarray,
    bin_size_m: float,
    n_bins: int | None = None,
    reducer=np.nanmedian,
) -> np.ndarray:
    """Reduce per-window values into fixed-size spatial bins (NaN where empty)."""
    idx = bin_index(distance_m, bin_size_m)
    if n_bins is None:
        n_bins = int(idx.max()) + 1 if idx.size else 0
    out = np.full(n_bins, np.nan)
    for b in range(n_bins):
        m = idx == b
        if m.any():
            out[b] = reducer(np.asarray(values, dtype=float)[m])
    return out
