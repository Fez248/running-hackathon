"""Anomaly detectors: single-pass, multi-pass and modal-shift."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from imukit.geo import aggregate_by_bin
from imukit.modal import find_modes, frequency_shift
from imukit.robust import leave_one_out_z, robust_z

from .pipeline import ProcessedPass

# Feature panels. "excess" = anomaly injects transient energy (loose slab, loose
# board); "attenuation" = anomaly removes high-frequency energy and smears the
# impact (mat, wet patch, any compliant lossy layer).
EXCESS_FEATURES = ("res_rms", "res_p95", "e_shock", "shock_struct_ratio", "hf_frac")
ATTENUATION_FEATURES = ("hf_frac", "shock_struct_ratio", "centroid_hz", "res_crest", "res_kurtosis")
# Features that are strictly positive and heavy-tailed: scored in log space, where
# they are far closer to Gaussian, which is what keeps the robust z-threshold
# meaningful instead of firing on every ordinary hard footstrike.
LOG_FEATURES = (
    "res_rms",
    "res_p95",
    "e_gait",
    "e_struct",
    "e_shock",
    "e_hf",
    "shock_struct_ratio",
    "hf_frac",
)


@dataclass
class Detection:
    start_m: float
    end_m: float
    peak_m: float
    score: float
    direction: str  # "excess" or "attenuation"


@dataclass
class PassScores:
    distance_m: np.ndarray
    excess: np.ndarray
    attenuation: np.ndarray

    @property
    def signed(self) -> np.ndarray:
        """One score per window; positive = excess shock, negative = attenuation."""
        return np.where(self.excess >= self.attenuation, self.excess, -self.attenuation)


def score_pass(pp: ProcessedPass) -> PassScores:
    """Single-pass scoring: each window against the trace's own robust baseline.

    Single-pass works only because the baseline surface dominates the route; the
    median/MAD baseline is estimated from the same trace with the most extreme
    windows excluded (``leave_one_out_z``).
    """
    z: dict[str, np.ndarray] = {}
    for k, v in pp.features.items():
        x = np.log(np.maximum(v, 1e-12)) if k in LOG_FEATURES else v
        z[k] = leave_one_out_z(x)
    # Consensus (median over the panel) rather than max: a single feature spiking
    # is usually one odd footstrike, whereas a defect moves the whole panel.
    excess = np.median(np.vstack([z[k] for k in EXCESS_FEATURES if k in z]), axis=0)
    attenuation = np.median(np.vstack([-z[k] for k in ATTENUATION_FEATURES if k in z]), axis=0)
    return PassScores(distance_m=pp.window_distance_m, excess=excess, attenuation=attenuation)


def _segments_above(mask: np.ndarray) -> list[tuple[int, int]]:
    segs, start = [], None
    for i, m in enumerate(mask):
        if m and start is None:
            start = i
        elif not m and start is not None:
            segs.append((start, i - 1))
            start = None
    if start is not None:
        segs.append((start, len(mask) - 1))
    return segs


def detect_single_pass(
    pp: ProcessedPass,
    threshold: float = 3.0,
    min_windows: int = 2,
    merge_gap_m: float = 6.0,
    attenuation_threshold: float | None = None,
) -> list[Detection]:
    """Flag contiguous runs of windows whose robust z exceeds the threshold.

    ``threshold`` defaults to the best operating point of the sweep in
    docs/FEASIBILITY.md (E2): 3.0 gives precision 1.0 at recall 0.8 on the
    synthetic route, while 2.5 buys the last anomaly at the cost of half the
    precision. ``attenuation_threshold`` defaults to ``threshold``.
    """
    sc = score_pass(pp)
    out: list[Detection] = []
    thresholds = {"excess": threshold, "attenuation": attenuation_threshold or threshold}
    for name, values in (("excess", sc.excess), ("attenuation", sc.attenuation)):
        mask = values >= thresholds[name]
        for a, b in _segments_above(mask):
            if b - a + 1 < min_windows:
                continue
            peak = int(a + np.argmax(values[a : b + 1]))
            out.append(
                Detection(
                    start_m=float(sc.distance_m[a]),
                    end_m=float(sc.distance_m[b]),
                    peak_m=float(sc.distance_m[peak]),
                    score=float(values[peak]),
                    direction=name,
                )
            )
    return _merge(out, merge_gap_m)


def _merge(dets: list[Detection], gap_m: float) -> list[Detection]:
    dets = sorted(dets, key=lambda d: d.start_m)
    merged: list[Detection] = []
    for d in dets:
        if merged and d.direction == merged[-1].direction and d.start_m - merged[-1].end_m <= gap_m:
            prev = merged[-1]
            keep_new = d.score > prev.score
            merged[-1] = Detection(
                start_m=prev.start_m,
                end_m=max(prev.end_m, d.end_m),
                peak_m=d.peak_m if keep_new else prev.peak_m,
                score=max(prev.score, d.score),
                direction=prev.direction,
            )
        else:
            merged.append(d)
    return merged


@dataclass
class BinnedMap:
    bin_size_m: float
    edges_m: np.ndarray
    score: np.ndarray  # (n_bins,) consensus score
    coverage: np.ndarray  # (n_bins,) number of passes contributing


def multi_pass_map(
    passes: list[ProcessedPass],
    bin_size_m: float = 5.0,
    length_m: float | None = None,
) -> BinnedMap:
    """Aggregate per-pass window scores into a spatial consensus map.

    Independent runners share the surface but not their gait, so gait-driven
    false positives average out while a real defect reinforces. The consensus
    statistic is the per-bin median over passes, which needs >=3 passes to be
    meaningfully robust.
    """
    if length_m is None:
        length_m = max(float(np.max(p.window_distance_m)) for p in passes)
    n_bins = int(np.ceil(length_m / bin_size_m))
    rows = []
    for pp in passes:
        sc = score_pass(pp)
        rows.append(aggregate_by_bin(sc.distance_m, sc.signed, bin_size_m, n_bins=n_bins))
    mat = np.vstack(rows)
    with np.errstate(invalid="ignore"):
        consensus = np.nanmedian(mat, axis=0)
    coverage = np.sum(np.isfinite(mat), axis=0)
    edges = np.arange(n_bins + 1) * bin_size_m
    return BinnedMap(bin_size_m=bin_size_m, edges_m=edges, score=consensus, coverage=coverage)


def detect_multi_pass(
    passes: list[ProcessedPass],
    bin_size_m: float = 5.0,
    threshold: float = 2.5,
    min_coverage: int | None = None,
) -> tuple[list[Detection], BinnedMap]:
    if min_coverage is None:
        min_coverage = max(1, min(2, len(passes)))
    bm = multi_pass_map(passes, bin_size_m=bin_size_m)
    score = np.nan_to_num(bm.score, nan=0.0)
    ok = bm.coverage >= min_coverage
    dets: list[Detection] = []
    for name, values in (("excess", score), ("attenuation", -score)):
        mask = (values >= threshold) & ok
        for a, b in _segments_above(mask):
            peak = int(a + np.argmax(values[a : b + 1]))
            dets.append(
                Detection(
                    start_m=float(bm.edges_m[a]),
                    end_m=float(bm.edges_m[b + 1]),
                    peak_m=float(bm.edges_m[peak] + bin_size_m / 2),
                    score=float(values[peak]),
                    direction=name,
                )
            )
    return _merge(dets, bin_size_m), bm


@dataclass
class ModalReading:
    freq_hz: float
    zeta: float | None
    shift: float | None = None


def modal_signature(
    pp: ProcessedPass,
    f_range: tuple[float, float] = (3.0, 15.0),
    span: tuple[float, float] | None = None,
) -> ModalReading | None:
    """Pick the dominant structural mode of a (sub)segment of one pass.

    Cadence harmonics are notched out of the PSD first; without that, the mode
    estimate simply tracks the runner's cadence.
    """
    vert = pp.vert
    if span is not None and pp.window_t.size > 1:
        d_samples = np.interp(pp.t, pp.window_t, pp.window_distance_m)
        sel = (d_samples >= span[0]) & (d_samples <= span[1])
        # Below ~4 s of data the frequency resolution is too coarse to compare passes.
        if sel.sum() <= pp.fs * 4:
            return None
        vert = vert[sel]
    modes = find_modes(vert, pp.fs, f_range=f_range, f_step=pp.f_step, max_modes=1)
    if not modes:
        return None
    return ModalReading(freq_hz=modes[0].freq_hz, zeta=modes[0].zeta)


def harmonic_blocked(f_step: float, f_target: float, tol_hz: float = 0.5, n_harmonics: int = 12) -> bool:
    """True when a cadence harmonic sits on top of the mode of interest.

    A mode within ~0.5 Hz of k*f_step is simply not observable in that pass: the
    harmonic is orders of magnitude stronger and notching it removes the mode too.
    Mitigation is diversity - passes at different cadences, or walkers vs runners.
    """
    return any(abs(f_target - k * f_step) <= tol_hz for k in range(1, n_harmonics + 1))


def track_modal_shift(
    baseline: list[ModalReading],
    current: ModalReading,
    alarm_frac: float = 0.02,
) -> tuple[float, bool]:
    """Compare a reading against the median baseline frequency.

    ``alarm_frac`` defaults to 2%: below that, day-to-day temperature, mass
    loading and crowd effects on real bridges are of the same order as damage.
    """
    ref = float(np.median([b.freq_hz for b in baseline]))
    shift = frequency_shift(ref, current.freq_hz)
    return shift, bool(abs(shift) >= alarm_frac)


def robust_zmap(values: np.ndarray) -> np.ndarray:
    """Convenience wrapper used by reports/plots."""
    return robust_z(values)
