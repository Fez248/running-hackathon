import numpy as np
import pytest
from imukit.features import band_energy, psd

from bridge.pipeline import process_pass, stride_template, suppress_cadence
from bridge.synth import Anomaly, SurfaceScenario, simulate_pass


def test_suppress_cadence_removes_periodic_component():
    fs = 200.0
    t = np.arange(0, 20, 1 / fs)
    f0 = 2.5
    x = 3.0 * np.sin(2 * np.pi * f0 * t) + 0.8 * np.sin(2 * np.pi * 2 * f0 * t)
    step = int(fs / f0)
    segs = [(i, i + step) for i in range(0, len(x) - step, step)]
    res, tmpl = suppress_cadence(x, segs)
    inner = slice(segs[0][0], segs[-1][1])
    assert tmpl.size == stride_template(x, segs).size
    assert np.std(res[inner]) < 0.05 * np.std(x[inner])


def test_suppress_cadence_preserves_injected_transient():
    fs = 200.0
    t = np.arange(0, 20, 1 / fs)
    f0 = 2.5
    x = 3.0 * np.sin(2 * np.pi * f0 * t)
    burst = np.exp(-np.arange(60) / 12) * np.sin(2 * np.pi * 25 * np.arange(60) / fs) * 4
    at = int(10 * fs)
    x[at : at + 60] += burst
    step = int(fs / f0)
    segs = [(i, i + step) for i in range(0, len(x) - step, step)]
    res, _ = suppress_cadence(x, segs)
    assert np.max(np.abs(res[at : at + 60])) > 0.6 * np.max(np.abs(burst))


def test_process_pass_estimates_cadence_and_windows():
    scn = SurfaceScenario(seed=5, length_m=150.0, anomalies=[])
    trace, gps, _ = simulate_pass(scn)
    pp = process_pass(trace, gps)
    assert pp.f_step == pytest.approx(scn.step_freq_hz, abs=0.2)
    assert pp.n_windows > 40
    assert pp.window_distance_m[-1] == pytest.approx(scn.length_m, rel=0.15)
    for key in ("res_rms", "hf_frac", "res_kurtosis", "e_shock"):
        assert key in pp.features and np.all(np.isfinite(pp.features[key]))


def test_pipeline_suppresses_gait_band_more_than_shock_band():
    scn = SurfaceScenario(seed=6, length_m=200.0, anomalies=[])
    trace, gps, _ = simulate_pass(scn)
    pp = process_pass(trace, gps)
    f, p_raw = psd(pp.vert, pp.fs)
    _, p_res = psd(pp.residual, pp.fs)
    gait_ratio = band_energy(f, p_res, 0.5, 6.0) / band_energy(f, p_raw, 0.5, 6.0)
    shock_ratio = band_energy(f, p_res, 20.0, 45.0) / band_energy(f, p_raw, 20.0, 45.0)
    assert gait_ratio < 0.05
    assert shock_ratio > 5 * gait_ratio


def test_synth_anomaly_changes_local_statistics():
    common = dict(length_m=200.0, seed=11)
    clean, _, _ = simulate_pass(SurfaceScenario(anomalies=[], **common))
    dirty, _, _ = simulate_pass(SurfaceScenario(anomalies=[Anomaly("loose_slab", 90.0, 110.0)], **common))
    assert np.std(dirty.accel) > np.std(clean.accel)
