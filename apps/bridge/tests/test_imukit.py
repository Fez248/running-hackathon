import numpy as np
import pytest
from imukit.cadence import detect_footfalls, estimate_step_frequency
from imukit.geo import aggregate_by_bin, cumulative_distance, haversine_m
from imukit.modal import find_modes, notch_harmonics
from imukit.preprocess import bandpass, gravity_split, resample_uniform
from imukit.robust import ewma_update, leave_one_out_z, mad, robust_z
from imukit.types import GpsTrack, ImuTrace


def test_resample_uniform_handles_jittered_timestamps():
    t = np.sort(np.random.default_rng(0).uniform(0, 10, 900))
    x = np.sin(2 * np.pi * 1.0 * t)
    tu, xu = resample_uniform(t, x, 100.0)
    assert np.allclose(np.diff(tu), 0.01)
    assert np.max(np.abs(xu - np.sin(2 * np.pi * tu))) < 0.05


def test_bandpass_rejects_out_of_band_tone():
    fs = 200.0
    t = np.arange(0, 5, 1 / fs)
    x = np.sin(2 * np.pi * 1.0 * t) + np.sin(2 * np.pi * 30.0 * t)
    y = bandpass(x, fs, 20.0, 45.0)
    assert np.std(y) == pytest.approx(np.std(np.sin(2 * np.pi * 30 * t)), rel=0.15)


def test_gravity_split_is_orientation_invariant():
    fs = 100.0
    t = np.arange(0, 20, 1 / fs)
    vert = 2.0 * np.sin(2 * np.pi * 2.5 * t)
    axis = np.array([0.3, -0.4, 0.86])
    axis /= np.linalg.norm(axis)
    accel = np.outer(9.80665 + vert, axis)
    v, h = gravity_split(ImuTrace(t=t, accel=accel, fs=fs))
    mid = slice(int(2 * fs), int(18 * fs))
    assert np.corrcoef(v[mid], vert[mid])[0, 1] > 0.99
    assert np.std(h[mid]) < 0.2


def test_estimate_step_frequency_prefers_fundamental_over_harmonic():
    fs = 100.0
    t = np.arange(0, 30, 1 / fs)
    f0 = 2.7
    x = np.sin(2 * np.pi * f0 * t) + 2.5 * np.sin(2 * np.pi * 2 * f0 * t)
    assert estimate_step_frequency(x, fs) == pytest.approx(f0, abs=0.15)


def test_detect_footfalls_counts_impacts():
    fs = 200.0
    dur, f0 = 20.0, 2.5
    t = np.arange(0, dur, 1 / fs)
    x = np.zeros_like(t)
    idx = (np.arange(0, dur, 1 / f0) * fs).astype(int)[:-1]
    for i in idx:
        x[i : i + 20] += np.hanning(20) * 5
    peaks = detect_footfalls(x, fs, f_step=f0)
    assert abs(peaks.size - idx.size) <= 2


def test_robust_stats():
    x = np.concatenate([np.random.default_rng(1).normal(0, 1, 200), [50.0]])
    assert abs(float(mad(x)) - 1.0) < 0.25
    assert robust_z(x)[-1] > 20
    assert leave_one_out_z(x)[-1] > robust_z(x)[-1] * 0.5


def test_ewma_update_handles_nans():
    ref = np.array([1.0, np.nan, 3.0])
    obs = np.array([2.0, 5.0, np.nan])
    out = ewma_update(ref, obs, alpha=0.5)
    assert out[0] == pytest.approx(1.5)
    assert out[1] == pytest.approx(5.0)
    assert out[2] == pytest.approx(3.0)


def test_geo_distance_and_binning():
    lat = 51.5 + np.arange(11) * (10.0 / 111_320.0)
    trk = GpsTrack(t=np.arange(11.0), lat=lat, lon=np.full(11, -0.12))
    d = cumulative_distance(trk)
    assert d[-1] == pytest.approx(100.0, rel=0.02)
    assert haversine_m(51.5, -0.12, 51.5, -0.12) == pytest.approx(0.0, abs=1e-6)
    binned = aggregate_by_bin(np.array([0.0, 4.0, 6.0, 12.0]), np.array([1.0, 3.0, 10.0, 7.0]), 5.0, n_bins=3)
    assert binned[0] == pytest.approx(2.0)
    assert binned[1] == pytest.approx(10.0)
    assert binned[2] == pytest.approx(7.0)


def test_notch_harmonics_removes_cadence_peaks():
    f = np.linspace(0, 50, 501)
    pxx = np.ones_like(f) * 0.1
    for k in range(1, 5):
        pxx[np.argmin(np.abs(f - k * 2.5))] = 100.0
    out = notch_harmonics(f, pxx, 2.5)
    assert out.max() < 1.0


def test_find_modes_recovers_known_resonance():
    fs = 200.0
    t = np.arange(0, 60, 1 / fs)
    rng = np.random.default_rng(3)
    imp = np.zeros_like(t)
    imp[:: int(fs / 2.5)] = 1.0
    h = np.exp(-2 * np.pi * 0.03 * 6.5 * np.arange(0, 6, 1 / fs)) * np.sin(
        2 * np.pi * 6.5 * np.arange(0, 6, 1 / fs)
    )
    x = np.convolve(imp, h, mode="same") + rng.normal(0, 0.02, t.size)
    modes = find_modes(x, fs, f_range=(3.0, 15.0), f_step=2.5, max_modes=1)
    assert modes and modes[0].freq_hz == pytest.approx(6.5, abs=0.4)
    assert modes[0].zeta is None or 0.0 < modes[0].zeta < 0.5
