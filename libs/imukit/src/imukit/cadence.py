"""Cadence estimation, footfall detection and stride segmentation."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.signal import find_peaks, welch

from .preprocess import bandpass

STEP_FREQ_RANGE = (1.0, 3.6)  # Hz, covers slow walking (~2 Hz) to fast running (~3.2 Hz)

# A human step is between half a metre and a metre and a half. Anything outside
# that is not a step: on a measured 3110 m pass at 3.17 m/s the estimator
# returned 1.5 Hz, which is 2.04 m of ground per "step" — a stride, and the
# giveaway that the harmonic product had locked onto the wrong fundamental.
PLAUSIBLE_STEP_LENGTH_M = (0.5, 1.6)

# Above this, consecutive footfall intervals alternate too strongly to be a
# series of steps. Real left/right asymmetry is a few per cent; a series that
# alternates by a third is one peak per stride plus a spurious peak between, or
# vice versa, so the interval median cannot be trusted as the step rate.
MAX_STEP_INTERVAL_ASYMMETRY = 0.35

# 240 spm. Elite sprinters reach ~260 briefly; sustained over a pass, anything
# above this is not a step rate, so doubling into it is never the answer.
MAX_STEP_FREQ_HZ = 4.0


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


def interval_asymmetry(footfalls: np.ndarray, fs: float) -> float:
    """Alternation between odd and even footfall intervals, relative to the median.

    A step series has near-equal consecutive intervals (left/right asymmetry is
    a few per cent). A series that is really one peak per stride with a weaker
    peak between them alternates long/short, and this is what shows it.
    """
    if footfalls.size < 4:
        return 0.0
    iv = np.diff(np.asarray(footfalls, dtype=float)) / fs
    med = float(np.median(iv))
    if med <= 0:
        return 0.0
    odd, even = iv[::2], iv[1::2]
    if odd.size == 0 or even.size == 0:
        return 0.0
    return float(abs(np.median(odd) - np.median(even)) / med)


@dataclass
class CadenceEstimate:
    """A step frequency and the evidence for it being the step, not the stride."""

    #: Chosen fundamental, Hz.
    f_step: float
    #: What the harmonic-product spectrum alone returned, Hz.
    f_spectral: float
    #: What decided it: ``gps_speed``, ``footfall_intervals`` or ``spectrum``.
    basis: str
    #: True when the spectral estimate was the stride and has been doubled.
    corrected: bool = False
    speed_mps: float | None = None
    #: Ground covered per step at the chosen frequency; the physical sanity check.
    step_length_m: float | None = None
    #: Step rate implied by the footfall intervals, Hz.
    f_footfall: float | None = None
    asymmetry: float | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def spm(self) -> float:
        return cadence_spm(self.f_step)

    def as_dict(self) -> dict:
        return {
            "spm": self.spm,
            "f_step_hz": self.f_step,
            "f_spectral_hz": self.f_spectral,
            "basis": self.basis,
            "corrected": self.corrected,
            "speed_mps": self.speed_mps,
            "step_length_m": self.step_length_m,
            "f_footfall_hz": self.f_footfall,
            "asymmetry": self.asymmetry,
            "notes": list(self.notes),
        }


def _step_length(speed_mps: float, f: float) -> float:
    return speed_mps / f


def _plausible(step_length_m: float) -> bool:
    lo, hi = PLAUSIBLE_STEP_LENGTH_M
    return lo <= step_length_m <= hi


def _refined_double(vert: np.ndarray, fs: float, f_spectral: float) -> float:
    """The step-rate candidate: twice ``f_spectral``, re-peaked at its own scale.

    Doubling also doubles the spectral grid spacing, so ``2 x 1.5 Hz`` would
    report 180 spm for a pass actually run at 173. Re-running the estimator in a
    narrow band around the doubled value costs nothing and gives the candidate
    the resolution the original estimate had.
    """
    doubled = 2.0 * f_spectral
    lo, hi = 0.85 * doubled, min(1.15 * doubled, fs / 2 * 0.9)
    if hi <= lo:
        return doubled
    try:
        return estimate_step_frequency(vert, fs, (lo, hi))
    except ValueError:
        return doubled


def resolve_step_frequency(
    vert: np.ndarray,
    fs: float,
    speed_mps: float | None = None,
    f_range: tuple[float, float] = STEP_FREQ_RANGE,
) -> CadenceEstimate:
    """Step frequency with the stride/step ambiguity resolved, plus its evidence.

    The harmonic product spectrum can still settle on the stride: both feet
    together produce a strong component at half the step rate, and for a runner
    with a pronounced left/right difference it can dominate. Halving the cadence
    is not a cosmetic error — :func:`stride_segments` then spans two steps, the
    stride template is fitted over double-length segments, and the residual
    keeps energy the suppression was supposed to remove, which is what turned a
    z=10 detection into z=3.8.

    So the fundamental is cross-checked two independent ways before it is
    believed: against ground speed, where the implied step length has to be a
    length a human steps (0.5-1.6 m), and against the footfall intervals, which
    are timing rather than spectrum. Only the ``x2`` correction is considered —
    the spectral estimate is either the step rate or the stride rate.
    """
    f_spectral = estimate_step_frequency(vert, fs, f_range)
    doubled = _refined_double(vert, fs, f_spectral)
    notes: list[str] = []

    footfalls = detect_footfalls(vert, fs, f_step=doubled)
    asym = interval_asymmetry(footfalls, fs)
    f_ff: float | None = None
    if footfalls.size >= 4:
        med = float(np.median(np.diff(footfalls.astype(float)) / fs))
        if med > 0:
            f_ff = 1.0 / med

    def _estimate(f: float, basis: str) -> CadenceEstimate:
        return CadenceEstimate(
            f_step=f,
            f_spectral=f_spectral,
            basis=basis,
            corrected=f > f_spectral * 1.5,
            speed_mps=speed_mps,
            step_length_m=None if not speed_mps else _step_length(speed_mps, f),
            f_footfall=f_ff,
            asymmetry=asym if footfalls.size >= 4 else None,
            notes=notes,
        )

    if speed_mps and speed_mps > 0.5:
        at_spectral = _plausible(_step_length(speed_mps, f_spectral))
        at_doubled = doubled <= MAX_STEP_FREQ_HZ and _plausible(_step_length(speed_mps, doubled))
        if at_doubled and not at_spectral:
            notes.append(
                f"spectral fundamental {f_spectral:.2f} Hz implies "
                f"{_step_length(speed_mps, f_spectral):.2f} m per step at {speed_mps:.2f} m/s, "
                f"which is a stride; using {doubled:.2f} Hz "
                f"({_step_length(speed_mps, doubled):.2f} m per step)"
            )
            return _estimate(doubled, "gps_speed")
        if at_spectral and not at_doubled:
            return _estimate(f_spectral, "gps_speed")
        if not at_spectral and not at_doubled:
            notes.append(
                f"neither {f_spectral:.2f} Hz nor {doubled:.2f} Hz gives a plausible step length at "
                f"{speed_mps:.2f} m/s; cadence is unreliable for this pass"
            )

    # Speed was absent or could not separate the two. Timing can: the footfall
    # interval median is an estimate that owes the spectrum nothing, as long as
    # the intervals do not alternate (which would mean the peaks are not steps).
    if f_ff is not None and asym <= MAX_STEP_INTERVAL_ASYMMETRY:
        nearer_doubled = doubled <= MAX_STEP_FREQ_HZ and abs(np.log(f_ff / doubled)) < abs(
            np.log(f_ff / f_spectral)
        )
        if nearer_doubled:
            notes.append(
                f"footfall intervals imply {f_ff:.2f} Hz, twice the spectral "
                f"{f_spectral:.2f} Hz: the spectrum locked onto the stride"
            )
            return _estimate(doubled, "footfall_intervals")
        return _estimate(f_spectral, "footfall_intervals")

    if f_ff is not None:
        notes.append(
            f"footfall intervals alternate by {asym:.0%} (limit "
            f"{MAX_STEP_INTERVAL_ASYMMETRY:.0%}), so they cannot confirm the step rate"
        )
    return _estimate(f_spectral, "spectrum")
