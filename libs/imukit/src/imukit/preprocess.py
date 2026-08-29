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


def dc_magnitude(accel: np.ndarray, fs: float, cutoff: float = 0.4) -> float:
    """Median magnitude of the sub-``cutoff`` component of ``accel``.

    Gait and orientation changes live above that cutoff, so the low-passed norm
    is ~g for a gravity-carrying stream and ~0 for a linear/user-acceleration
    one however vigorous the motion — the mean raw norm is not, because hard
    running averages well above 0.5 g with gravity already removed.

    Its unit is the stream's own, which is what makes it usable both as a
    gravity test and as the scale test that tells g from m/s^2.
    """
    accel = np.asarray(accel, dtype=float)
    if fs <= 4 * cutoff or accel.shape[0] < 64:
        return float(np.linalg.norm(np.mean(accel, axis=0)))
    return float(np.median(np.linalg.norm(lowpass(accel, fs, cutoff), axis=1)))


def dc_steadiness(accel: np.ndarray, fs: float, cutoff: float = 0.4) -> float:
    """Spread of the sub-``cutoff`` norm relative to its median (IQR / median).

    Gravity is a constant: whatever unit it is reported in, and however the
    phone is carried, the low-passed norm of a stream that carries it barely
    moves. A linear-acceleration stream's low-passed norm is drift, so it
    wanders over its own scale. That difference is unit-free, which is what lets
    it tell a 1 g stream from a gravity-free stream whose drift happens to sit
    at 1 m/s^2 — the two are indistinguishable by magnitude alone.
    """
    accel = np.asarray(accel, dtype=float)
    if fs <= 4 * cutoff or accel.shape[0] < 64:
        return float("inf")
    norm = np.linalg.norm(lowpass(accel, fs, cutoff), axis=1)
    median = float(np.median(norm))
    if median <= 1e-9:
        return float("inf")
    return float(np.subtract(*np.percentile(norm, [75, 25])) / median)


def ac_rms(accel: np.ndarray, fs: float, cutoff: float = 0.4) -> float:
    """RMS magnitude of the above-``cutoff`` component of ``accel``, in its own unit.

    Paired with :func:`dc_magnitude` it says whether a DC term is a steady pull
    or just drift: gravity is a constant of the stream's scale, so a
    gravity-carrying stream has a DC comparable to its motion, while a
    linear-acceleration stream's residual DC is small next to it.
    """
    accel = np.asarray(accel, dtype=float)
    if fs <= 4 * cutoff or accel.shape[0] < 64:
        centred = accel - np.mean(accel, axis=0)
    else:
        centred = accel - lowpass(accel, fs, cutoff)
    return float(np.sqrt(np.mean(np.sum(centred**2, axis=1))))


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
