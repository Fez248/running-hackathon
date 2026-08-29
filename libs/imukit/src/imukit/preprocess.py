"""Resampling, filtering and gravity/vertical decomposition."""

from __future__ import annotations

import numpy as np
from scipy.signal import butter, sosfiltfilt

from .types import ImuTrace

G = 9.80665


def resample_uniform(t: np.ndarray, x: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """Linearly resample jitter-prone phone samples onto a uniform ``fs`` grid.

    Phone IMU timestamps drift and drop samples; every downstream spectral step
    assumes a uniform grid, so this is always the first stage of the pipeline.
    """
    t = np.asarray(t, dtype=float)
    x = np.asarray(x, dtype=float)
    if t.size < 2:
        raise ValueError("need at least two samples to resample")
    n = int(np.floor((t[-1] - t[0]) * fs)) + 1
    tu = t[0] + np.arange(n) / fs
    if x.ndim == 1:
        return tu, np.interp(tu, t, x)
    cols = [np.interp(tu, t, x[:, i]) for i in range(x.shape[1])]
    return tu, np.column_stack(cols)


def _sos(kind: str, cutoff, fs: float, order: int = 4):
    nyq = fs / 2.0
    if kind == "band":
        lo, hi = cutoff
        hi = min(hi, nyq * 0.98)
        return butter(order, [lo / nyq, hi / nyq], btype="bandpass", output="sos")
    if kind == "low":
        return butter(order, min(cutoff, nyq * 0.98) / nyq, btype="lowpass", output="sos")
    if kind == "high":
        return butter(order, cutoff / nyq, btype="highpass", output="sos")
    raise ValueError(f"unknown filter kind {kind!r}")


def bandpass(x: np.ndarray, fs: float, lo: float, hi: float, order: int = 4) -> np.ndarray:
    return sosfiltfilt(_sos("band", (lo, hi), fs, order), x, axis=0)


def lowpass(x: np.ndarray, fs: float, cutoff: float, order: int = 4) -> np.ndarray:
    return sosfiltfilt(_sos("low", cutoff, fs, order), x, axis=0)


def highpass(x: np.ndarray, fs: float, cutoff: float, order: int = 4) -> np.ndarray:
    return sosfiltfilt(_sos("high", cutoff, fs, order), x, axis=0)


def gravity_split(trace: ImuTrace, cutoff: float = 0.4) -> tuple[np.ndarray, np.ndarray]:
    """Split accel into vertical (gravity-aligned) and horizontal magnitude.

    The gravity direction is tracked with a very low-pass filter, which makes the
    result invariant to how the phone is carried (hand, pocket, armband) as long
    as the orientation is quasi-static over a few seconds.
    """
    gravity = lowpass(trace.accel, trace.fs, cutoff)
    norm = np.linalg.norm(gravity, axis=1, keepdims=True)
    norm = np.where(norm < 1e-6, 1e-6, norm)
    ghat = gravity / norm
    vert = np.sum(trace.accel * ghat, axis=1) - norm[:, 0]
    horiz = trace.accel - ghat * np.sum(trace.accel * ghat, axis=1, keepdims=True)
    return vert, np.linalg.norm(horiz, axis=1)
