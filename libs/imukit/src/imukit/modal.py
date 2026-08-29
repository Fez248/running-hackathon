"""Operational modal analysis primitives (peak-picking + half-power damping)."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import find_peaks, medfilt, welch


@dataclass
class Mode:
    freq_hz: float
    power: float
    zeta: float | None = None


def notch_harmonics(
    f: np.ndarray,
    pxx: np.ndarray,
    f_step: float,
    n_harmonics: int = 8,
    width_hz: float = 0.25,
) -> np.ndarray:
    """Interpolate the PSD across cadence harmonics.

    Footfall harmonics are the single biggest confounder for modal peak picking:
    at 2.8 steps/s the 3rd harmonic sits at 8.4 Hz, right on top of a typical
    footbridge mode. Removing them by interpolation keeps the broadband shape.
    """
    out = np.asarray(pxx, dtype=float).copy()
    mask = np.zeros_like(out, dtype=bool)
    for k in range(1, n_harmonics + 1):
        mask |= np.abs(f - k * f_step) <= width_hz
    if mask.all() or not mask.any():
        return out
    out[mask] = np.interp(f[mask], f[~mask], out[~mask])
    return out


def modal_psd(
    x: np.ndarray,
    fs: float,
    f_step: float | None = None,
    nperseg_sec: float = 8.0,
) -> tuple[np.ndarray, np.ndarray]:
    nperseg = int(min(len(x), max(256, nperseg_sec * fs)))
    f, pxx = welch(x, fs=fs, nperseg=nperseg, noverlap=nperseg // 2)
    if f_step is not None:
        pxx = notch_harmonics(f, pxx, f_step)
    return f, pxx


def half_power_damping(f: np.ndarray, pxx: np.ndarray, f_peak: float) -> float | None:
    """Damping ratio from the -3 dB bandwidth around a peak."""
    i = int(np.argmin(np.abs(f - f_peak)))
    half = pxx[i] / 2.0
    lo = hi = None
    for j in range(i, 0, -1):
        if pxx[j] <= half:
            lo = f[j]
            break
    for j in range(i, len(f)):
        if pxx[j] <= half:
            hi = f[j]
            break
    if lo is None or hi is None or f[i] <= 0:
        return None
    return float((hi - lo) / (2 * f[i]))


def find_modes(
    x: np.ndarray,
    fs: float,
    f_range: tuple[float, float] = (3.0, 25.0),
    f_step: float | None = None,
    max_modes: int = 3,
) -> list[Mode]:
    f, pxx = modal_psd(x, fs, f_step=f_step)
    band = (f >= f_range[0]) & (f <= f_range[1])
    fb, pb = f[band], pxx[band]
    if fb.size < 5:
        return []
    # Rank by prominence on the *flattened* log PSD, not by raw power: a lightly
    # damped structural mode is a narrow prominent peak, while the surface impact
    # response is a broad high-power hump that raw-power ranking always wins with.
    df = float(fb[1] - fb[0])
    flat = flatten_spectrum(np.log(pb + 1e-18), width_bins=max(3, int(round(1.5 / df)) | 1))
    peaks, props = find_peaks(flat, prominence=0.05)
    if f_step is not None and peaks.size:
        # Interpolating across a harmonic leaves small bumps at the notch edges;
        # candidates that close to a harmonic are cadence artefacts, not modes.
        keep = np.ones(peaks.size, dtype=bool)
        for k in range(1, 12):
            keep &= np.abs(fb[peaks] - k * f_step) > 0.5
        if not keep.any():
            # Every candidate sits on a harmonic: this pass cannot observe a mode.
            return []
        peaks = peaks[keep]
        props = {"prominences": props["prominences"][keep]}
    if peaks.size == 0:
        peaks, order = np.array([int(np.argmax(flat))]), np.array([0])
    else:
        order = np.argsort(props["prominences"])[::-1][:max_modes]
    modes = []
    for p in peaks[order]:
        fp = _parabolic_peak(fb, flat, int(p))
        modes.append(Mode(freq_hz=fp, power=float(pb[p]), zeta=half_power_damping(f, pxx, fp)))
    return sorted(modes, key=lambda m: m.freq_hz)


def flatten_spectrum(log_pxx: np.ndarray, width_bins: int) -> np.ndarray:
    """Subtract a wide median-filtered background from a log spectrum.

    Removes the broad footfall/surface response envelope so that narrow modal
    peaks are picked (and located) without being pulled by the envelope slope.
    """
    if width_bins < 3 or log_pxx.size < width_bins:
        return log_pxx
    return log_pxx - medfilt(log_pxx, kernel_size=width_bins | 1)


def _parabolic_peak(f: np.ndarray, y: np.ndarray, i: int) -> float:
    """Sub-bin peak frequency by fitting a parabola to the 3 samples around ``i``."""
    if i <= 0 or i >= y.size - 1:
        return float(f[i])
    denom = y[i - 1] - 2 * y[i] + y[i + 1]
    if abs(denom) < 1e-12:
        return float(f[i])
    delta = 0.5 * (y[i - 1] - y[i + 1]) / denom
    delta = float(np.clip(delta, -1.0, 1.0))
    return float(f[i] + delta * (f[1] - f[0]))


def frequency_shift(baseline_hz: float, current_hz: float) -> float:
    """Relative modal frequency shift; negative means loss of stiffness."""
    return (current_hz - baseline_hz) / baseline_hz
