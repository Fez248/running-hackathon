"""Cadence estimation, footfall detection and stride segmentation."""

from __future__ import annotations

import numpy as np
from scipy.signal import find_peaks, welch

from .preprocess import bandpass

STEP_FREQ_RANGE = (1.0, 3.6)  # Hz, covers slow walking (~2 Hz) to fast running (~3.2 Hz)


def estimate_step_frequency(
    vert: np.ndarray,
    fs: float,
    f_range: tuple[float, float] = STEP_FREQ_RANGE,
    n_harmonics: int = 3,
) -> float:
    """Estimate step frequency with a harmonic product spectrum.

    A plain spectral peak often locks onto the 2nd harmonic (or, for walking, onto
    the stride rather than the step). Multiplying the spectrum by its decimated
    copies rewards the true fundamental, which carries the harmonic stack.
    """
    nperseg = int(min(len(vert), max(256, fs * 8)))
    f, pxx = welch(vert, fs=fs, nperseg=nperseg)
    band = (f >= f_range[0]) & (f <= f_range[1])
    if not band.any():
        raise ValueError("step-frequency band is empty for this sampling rate")
    score = np.log(pxx[band] + 1e-18)
    f_band = f[band]
    for k in range(2, n_harmonics + 1):
        score = score + np.interp(f_band * k, f, np.log(pxx + 1e-18))
    return float(f_band[int(np.argmax(score))])


def detect_footfalls(vert: np.ndarray, fs: float, f_step: float | None = None) -> np.ndarray:
    """Return sample indices of heel-strike impacts.

    Impacts are found on a 1-12 Hz band-passed vertical signal: below 1 Hz sits
    body sway and gravity leakage, above ~12 Hz sits the structural/surface
    response we explicitly do *not* want to use for timing.
    """
    if f_step is None:
        f_step = estimate_step_frequency(vert, fs)
    x = bandpass(vert, fs, 1.0, min(12.0, fs / 2 * 0.9))
    min_dist = max(1, int(0.55 * fs / f_step))
    thr = np.median(x) + 0.5 * np.std(x)
    peaks, _ = find_peaks(x, distance=min_dist, height=thr)
    return peaks


def stride_segments(footfalls: np.ndarray, n_samples: int) -> list[tuple[int, int]]:
    """Consecutive footfall-to-footfall intervals as (start, stop) index pairs."""
    segs = []
    for a, b in zip(footfalls[:-1], footfalls[1:], strict=False):
        if 0 <= a < b <= n_samples:
            segs.append((int(a), int(b)))
    return segs


def cadence_spm(f_step: float) -> float:
    """Steps per minute."""
    return 60.0 * f_step
