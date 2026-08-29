import numpy as np
import pytest

from bridge.detect import (
    detect_multi_pass,
    detect_single_pass,
    harmonic_blocked,
    modal_signature,
    multi_pass_map,
    score_pass,
    track_modal_shift,
)
from bridge.evaluate import evaluate_detections, roc_auc, window_labels
from bridge.pipeline import process_pass
from bridge.synth import Anomaly, SurfaceScenario, simulate_pass


def _pass(seed, anomalies, **kw):
    scn = SurfaceScenario(seed=seed, anomalies=anomalies, **kw)
    trace, gps, truth = simulate_pass(scn)
    return process_pass(trace, gps), truth


def test_clean_pass_produces_no_detections():
    pp, _ = _pass(21, [], length_m=300.0)
    assert detect_single_pass(pp, threshold=4.0) == []


def test_single_pass_finds_loose_slab():
    pp, truth = _pass(22, [Anomaly("loose_slab", 120.0, 132.0)], length_m=300.0)
    dets = detect_single_pass(pp)
    ev = evaluate_detections(dets, truth)
    assert ev.recall == 1.0
    assert ev.mean_localization_error_m is not None and ev.mean_localization_error_m < 15.0
    assert any(d.direction == "excess" for d in dets)


def test_attenuating_anomaly_scores_negative():
    pp, truth = _pass(23, [Anomaly("wet_mat", 100.0, 140.0)], length_m=300.0)
    sc = score_pass(pp)
    labels = window_labels(pp.window_distance_m, truth)
    assert np.median(sc.signed[labels]) < np.median(sc.signed[~labels])
    auc = roc_auc(np.abs(sc.signed), labels)
    assert auc is not None and auc > 0.75


def test_multi_pass_map_and_detection():
    anomalies = [Anomaly("loose_slab", 80.0, 90.0), Anomaly("loose_board", 200.0, 210.0)]
    passes = []
    for i in range(4):
        pp, truth = _pass(
            30 + i,
            anomalies,
            length_m=300.0,
            carry_gain=[1.0, 0.6, 0.35, 0.8][i],
            step_freq_hz=2.5 + 0.15 * i,
        )
        passes.append(pp)
    bm = multi_pass_map(passes, bin_size_m=5.0)
    assert bm.score.size == bm.edges_m.size - 1
    assert np.nanmax(bm.score) > 2.0
    dets, _ = detect_multi_pass(passes, bin_size_m=5.0)
    ev = evaluate_detections(dets, truth)
    assert ev.recall >= 0.5


def _modal_median(f_mode, seed0, cadences=(2.35, 2.45, 2.9, 3.05, 3.15)):
    readings = []
    for i, f_step in enumerate(cadences):
        pp, _ = _pass(
            seed0 + i,
            [],
            length_m=200.0,
            struct_mode_hz=f_mode,
            struct_mode_gain=0.35,
            step_freq_hz=f_step,
            step_freq_drift=0.02,
        )
        if harmonic_blocked(pp.f_step, f_mode):
            continue
        r = modal_signature(pp, f_range=(4.0, 9.0))
        if r is not None:
            readings.append(r)
    assert readings
    return readings


def test_modal_signature_recovers_baseline_frequency():
    readings = _modal_median(6.2, 40)
    est = float(np.median([r.freq_hz for r in readings]))
    assert est == pytest.approx(6.2, abs=0.35)


def test_modal_shift_alarm_fires_on_damaged_span():
    baseline = _modal_median(6.2, 40)
    damaged = _modal_median(6.2 * 0.92, 60)
    shift, alarm = track_modal_shift(baseline, modal_signature_median(damaged))
    assert shift < -0.03 and alarm


def modal_signature_median(readings):
    from bridge.detect import ModalReading

    return ModalReading(freq_hz=float(np.median([r.freq_hz for r in readings])), zeta=None)


def test_harmonic_blocked_flags_overlapping_cadence():
    assert harmonic_blocked(2.8, 5.6)
    assert not harmonic_blocked(2.35, 6.2)


def test_evaluate_detections_counts_false_positives():
    from bridge.detect import Detection

    dets = [Detection(0.0, 5.0, 2.0, 6.0, "excess"), Detection(200.0, 210.0, 205.0, 5.0, "excess")]
    ev = evaluate_detections(dets, [Anomaly("loose_slab", 198.0, 208.0)], tol_m=10.0)
    assert (ev.tp, ev.fp, ev.fn) == (1, 1, 0)
    assert ev.precision == pytest.approx(0.5)
