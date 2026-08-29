"""Robust statistics used for baseline-versus-anomaly comparison."""

from __future__ import annotations

import numpy as np

MAD_TO_SIGMA = 1.4826


def mad(x: np.ndarray, axis: int | None = None) -> np.ndarray | float:
    x = np.asarray(x, dtype=float)
    med = np.median(x, axis=axis, keepdims=True)
    return np.squeeze(MAD_TO_SIGMA * np.median(np.abs(x - med), axis=axis, keepdims=True))


def robust_z(x: np.ndarray, center: float | None = None, scale: float | None = None) -> np.ndarray:
    """Median/MAD z-score.

    Anomalies are rare by assumption, so median and MAD estimate the *baseline*
    surface from a trace that already contains the anomalies we look for.
    """
    x = np.asarray(x, dtype=float)
    c = float(np.median(x)) if center is None else center
    s = float(mad(x)) if scale is None else scale
    if not np.isfinite(s) or s < 1e-12:
        s = float(np.std(x)) or 1.0
    return (x - c) / s


def leave_one_out_z(x: np.ndarray, exclude_frac: float = 0.1) -> np.ndarray:
    """Robust z where the baseline excludes the most extreme ``exclude_frac``.

    Protects single-pass detection when an anomalous stretch is long enough to
    bias the median (e.g. a 30 m wet section of a 200 m run).
    """
    x = np.asarray(x, dtype=float)
    if x.size < 8:
        return robust_z(x)
    k = max(1, int(round(exclude_frac * x.size)))
    order = np.argsort(np.abs(x - np.median(x)))
    keep = x[order[: max(4, x.size - k)]]
    return robust_z(x, center=float(np.median(keep)), scale=float(mad(keep)))


def ewma_update(reference: np.ndarray, observation: np.ndarray, alpha: float = 0.3) -> np.ndarray:
    """Update a per-bin reference map with a new pass (NaN-aware)."""
    reference = np.asarray(reference, dtype=float)
    observation = np.asarray(observation, dtype=float)
    out = reference.copy()
    seen = np.isfinite(observation)
    fresh = seen & ~np.isfinite(reference)
    out[fresh] = observation[fresh]
    upd = seen & np.isfinite(reference) & ~fresh
    out[upd] = (1 - alpha) * reference[upd] + alpha * observation[upd]
    return out
