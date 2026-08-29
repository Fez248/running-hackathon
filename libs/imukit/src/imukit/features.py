"""Window-level spectral and shock features."""

from __future__ import annotations

import numpy as np
from scipy.signal import welch
from scipy.stats import kurtosis

DEFAULT_BANDS: dict[str, tuple[float, float]] = {
    "gait": (1.0, 6.0),
    "struct": (6.0, 20.0),
    "shock": (20.0, 45.0),
    "hf": (45.0, 90.0),
}


def psd(x: np.ndarray, fs: float, nperseg: int | None = None) -> tuple[np.ndarray, np.ndarray]:
    if nperseg is None:
        nperseg = int(min(len(x), max(64, 2 ** int(np.log2(max(len(x) // 2, 64))))))
    return welch(x, fs=fs, nperseg=min(nperseg, len(x)))


def band_energy(f: np.ndarray, pxx: np.ndarray, lo: float, hi: float) -> float:
    m = (f >= lo) & (f < hi)
    if not m.any():
        return 0.0
    return float(np.trapezoid(pxx[m], f[m]))


def spectral_entropy(pxx: np.ndarray) -> float:
    p = pxx / (pxx.sum() + 1e-18)
    p = np.where(p <= 0, 1e-18, p)
    return float(-(p * np.log(p)).sum() / np.log(len(p)))


def spectral_centroid(f: np.ndarray, pxx: np.ndarray) -> float:
    s = pxx.sum()
    return float((f * pxx).sum() / s) if s > 0 else 0.0


def crest_factor(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(x**2)))
    return float(np.max(np.abs(x)) / rms) if rms > 0 else 0.0


def window_features(
    residual: np.ndarray,
    fs: float,
    bands: dict[str, tuple[float, float]] | None = None,
) -> dict[str, float]:
    """Features describing the *non-cadence* part of one window.

    All of them are amplitude- or shape-based descriptors of transient content:
    a loose slab injects energy (rms/shock band up), a mat or wet patch removes
    high-frequency energy (shock band and crest down).
    """
    bands = bands or DEFAULT_BANDS
    f, pxx = psd(residual, fs)
    feats: dict[str, float] = {
        "res_rms": float(np.sqrt(np.mean(residual**2))),
        "res_p95": float(np.percentile(np.abs(residual), 95)),
        "res_kurtosis": float(kurtosis(residual, fisher=True, bias=False)),
        "res_crest": crest_factor(residual),
        "res_entropy": spectral_entropy(pxx),
        "centroid_hz": spectral_centroid(f, pxx),
    }
    for name, (lo, hi) in bands.items():
        feats[f"e_{name}"] = band_energy(f, pxx, min(lo, fs / 2), min(hi, fs / 2))
    total = sum(v for k, v in feats.items() if k.startswith("e_")) + 1e-18
    # Ratios are amplitude-invariant, so they survive the per-stride gain fit and
    # describe the *shape* of the surface response rather than the runner's effort.
    feats["shock_struct_ratio"] = feats.get("e_shock", 0.0) / (feats.get("e_struct", 0.0) + 1e-18)
    feats["hf_frac"] = (feats.get("e_shock", 0.0) + feats.get("e_hf", 0.0)) / total
    feats["struct_frac"] = feats.get("e_struct", 0.0) / total
    return feats
