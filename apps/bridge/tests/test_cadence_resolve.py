"""The step/stride ambiguity, fixtured from the measured 3110 m running pass.

That pass ran at 3.17 m/s and the scan reported 90 spm over 1526 footfalls:
2.04 m of ground per detected footfall, i.e. one detection per stride. The
synthetic pass here reproduces the cause — a runner whose left and right
footfalls differ enough that the stride component dominates the step
fundamental — so the resolver is tested against the failure, not against a
signal that was never ambiguous.
"""

import numpy as np
import pytest
from imukit.cadence import (
    MAX_STEP_INTERVAL_ASYMMETRY,
    estimate_step_frequency,
    interval_asymmetry,
    resolve_step_frequency,
)
from imukit.geo import GpsTrack

FS = 200.0
SPEED_MPS = 3.17  # 11.4 km/h
F_STEP = 2.88  # 173 spm
STEP_LENGTH_M = SPEED_MPS / F_STEP  # ~1.10 m


def asymmetric_running_vert(
    duration_s: float = 120.0,
    f_step: float = F_STEP,
    right_gain: float = 0.45,
    timing_skew: float = 0.15,
    sway: float = 0.3,
    fs: float = FS,
) -> np.ndarray:
    """Vertical acceleration of a runner with a pronounced left/right difference.

    Three things put the energy at the stride rate rather than the step rate,
    and all three are what a real runner does: the right footfall lands softer,
    it lands slightly early in the cycle, and body sway rises and falls once per
    stride. Together they give the ``f_step / 2`` component a full harmonic
    stack, which is the one spectrum in which a harmonic-product estimator
    prefers the stride.
    """
    n = int(duration_s * fs)
    x = np.zeros(n)
    width = max(8, int(0.06 * fs))
    impact = np.hanning(width) * np.sin(2 * np.pi * 12.0 * np.arange(width) / fs)
    period = 1.0 / f_step
    starts: list[float] = []
    at = 0.0
    while at < duration_s:
        starts.append(at)
        at += period * (1 + timing_skew) if len(starts) % 2 else period * (1 - timing_skew)
    for k, start in enumerate(starts):
        i = int(start * fs)
        if i + width >= n:
            break
        x[i : i + width] += impact * (1.0 if k % 2 == 0 else right_gain)
    return x + sway * np.sin(2 * np.pi * (f_step / 2) * np.arange(n) / fs)


def straight_track(duration_s: float = 120.0, speed_mps: float = SPEED_MPS) -> GpsTrack:
    t = np.arange(0.0, duration_s, 1.0)
    lat = 51.5386 + (t * speed_mps) / 111_320.0
    return GpsTrack(
        t=t,
        lat=lat,
        lon=np.full(t.size, -0.0166),
        accuracy_m=np.full(t.size, 4.44),
    )


def test_fixture_really_is_the_ambiguous_case():
    """Guard the fixture: without a strong stride harmonic the test proves nothing."""
    vert = asymmetric_running_vert()
    assert estimate_step_frequency(vert, FS) == pytest.approx(F_STEP / 2, rel=0.1)


def test_gps_speed_recovers_the_step_fundamental():
    vert = asymmetric_running_vert()
    est = resolve_step_frequency(vert, FS, speed_mps=SPEED_MPS)
    assert 170.0 <= est.spm <= 180.0
    assert est.corrected
    assert est.basis == "gps_speed"
    assert est.step_length_m == pytest.approx(STEP_LENGTH_M, rel=0.1)
    assert any("stride" in note for note in est.notes)


def test_plausible_step_length_is_left_alone():
    """A pass whose spectral fundamental already is the step rate is not doubled."""
    fs, f0 = FS, 2.7
    t = np.arange(0, 60, 1 / fs)
    vert = np.sin(2 * np.pi * f0 * t) + 2.5 * np.sin(2 * np.pi * 2 * f0 * t)
    est = resolve_step_frequency(vert, fs, speed_mps=2.9)
    assert est.f_step == pytest.approx(f0, abs=0.15)
    assert not est.corrected


def test_footfall_intervals_resolve_it_without_gps():
    """A milder asymmetry the peak finder can still see both feet in."""
    vert = asymmetric_running_vert(right_gain=0.85, timing_skew=0.15, sway=0.2)
    est = resolve_step_frequency(vert, FS, speed_mps=None)
    assert est.f_step == pytest.approx(F_STEP, rel=0.08)
    assert est.basis == "footfall_intervals"
    assert est.corrected


def test_interval_asymmetry_separates_step_series_from_stride_series():
    even = np.arange(0, 100) * (FS / F_STEP)
    assert interval_asymmetry(even, FS) < MAX_STEP_INTERVAL_ASYMMETRY
    alternating = np.cumsum(np.tile([FS / F_STEP * 0.5, FS / F_STEP * 1.5], 50))
    assert interval_asymmetry(alternating, FS) > MAX_STEP_INTERVAL_ASYMMETRY


def test_implausible_at_both_candidates_is_reported_not_hidden():
    """A 12 m/s "pass" (a phone in a car) cannot yield a step length; say so."""
    vert = asymmetric_running_vert()
    est = resolve_step_frequency(vert, FS, speed_mps=12.0)
    assert any("unreliable" in note for note in est.notes)


def test_process_pass_reports_the_cadence_check():
    from imukit.types import ImuTrace

    from bridge.pipeline import process_pass

    vert = asymmetric_running_vert()
    t = np.arange(vert.size) / FS
    accel = np.column_stack([np.zeros_like(vert), np.zeros_like(vert), 9.80665 + vert])
    pp = process_pass(ImuTrace(t=t, accel=accel, fs=FS), straight_track())
    assert pp.cadence is not None
    assert 170.0 <= pp.cadence.spm <= 180.0
    assert pp.f_step == pytest.approx(pp.cadence.f_step)
    assert pp.cadence.as_dict()["speed_mps"] == pytest.approx(SPEED_MPS, rel=0.15)
