"""Feasibility experiments E1-E6 (reproducible, seeded)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .detect import (
    Detection,
    ModalReading,
    detect_multi_pass,
    detect_single_pass,
    harmonic_blocked,
    modal_signature,
    score_pass,
    track_modal_shift,
)
from .evaluate import evaluate_detections, roc_auc, window_labels
from .pipeline import ProcessedPass, process_pass
from .synth import Anomaly, SurfaceScenario, simulate_pass

ROUTE_ANOMALIES = [
    Anomaly("loose_slab", 80.0, 88.0),
    Anomaly("wet_mat", 180.0, 205.0),
    Anomaly("loose_board", 300.0, 312.0),
]


@dataclass
class ExperimentResult:
    name: str
    summary: dict
    detail: dict


def _make_pass(seed: int, **overrides) -> tuple[ProcessedPass, list[Anomaly], SurfaceScenario]:
    scn = SurfaceScenario(seed=seed, anomalies=list(ROUTE_ANOMALIES), **overrides)
    trace, gps, truth = simulate_pass(scn)
    return process_pass(trace, gps), truth, scn


def e1_cadence_separation(seed: int = 1) -> ExperimentResult:
    """Does stride-template suppression actually remove the cadence component?"""
    pp, _truth, scn = _make_pass(seed)
    from imukit.features import band_energy, psd

    f, p_raw = psd(pp.vert, pp.fs)
    _f2, p_res = psd(pp.residual, pp.fs)
    gait_raw = band_energy(f, p_raw, 0.5, 6.0)
    gait_res = band_energy(f, p_res, 0.5, 6.0)
    shock_raw = band_energy(f, p_raw, 20.0, 45.0)
    shock_res = band_energy(f, p_res, 20.0, 45.0)
    return ExperimentResult(
        name="E1_cadence_separation",
        summary={
            "true_step_freq_hz": round(scn.step_freq_hz, 3),
            "estimated_step_freq_hz": round(pp.f_step, 3),
            "step_freq_abs_error_hz": round(abs(pp.f_step - scn.step_freq_hz), 4),
            "gait_band_suppression_db": round(10 * np.log10(gait_res / gait_raw), 2),
            "shock_band_retention_db": round(10 * np.log10(shock_res / shock_raw), 2),
            "footfalls_detected": int(pp.footfalls.size),
        },
        detail={"n_windows": pp.n_windows},
    )


def e2_single_pass_detection(seeds: tuple[int, ...] = (1, 2, 3, 4, 5)) -> ExperimentResult:
    """Single-pass detection quality at the default threshold."""
    per_seed, aucs = [], []
    for s in seeds:
        pp, truth, _ = _make_pass(s)
        dets = detect_single_pass(pp)
        ev = evaluate_detections(dets, truth)
        sc = score_pass(pp)
        labels = window_labels(pp.window_distance_m, truth)
        auc = roc_auc(np.abs(sc.signed), labels)
        aucs.append(auc)
        per_seed.append(
            {
                "seed": s,
                **ev.as_dict(),
                "roc_auc": None if auc is None else round(auc, 3),
                "detections": [d.__dict__ for d in dets],
            }
        )
    sweep = {}
    for thr in (2.0, 2.5, 3.0, 4.0, 5.0):
        evs = []
        for s in seeds:
            pp, truth, _ = _make_pass(s)
            evs.append(
                evaluate_detections(detect_single_pass(pp, threshold=thr, attenuation_threshold=thr), truth)
            )
        sweep[thr] = {
            "precision": round(float(np.mean([e.precision for e in evs])), 3),
            "recall": round(float(np.mean([e.recall for e in evs])), 3),
            "f1": round(float(np.mean([e.f1 for e in evs])), 3),
        }

    return ExperimentResult(
        name="E2_single_pass",
        summary={
            "n_passes": len(seeds),
            "symmetric_threshold_sweep": sweep,
            "mean_precision": round(float(np.mean([p["precision"] for p in per_seed])), 3),
            "mean_recall": round(float(np.mean([p["recall"] for p in per_seed])), 3),
            "mean_f1": round(float(np.mean([p["f1"] for p in per_seed])), 3),
            "mean_roc_auc": round(float(np.mean([a for a in aucs if a is not None])), 3),
            "mean_localization_error_m": round(
                float(
                    np.mean(
                        [
                            p["mean_localization_error_m"]
                            for p in per_seed
                            if p["mean_localization_error_m"] is not None
                        ]
                        or [np.nan]
                    )
                ),
                2,
            ),
        },
        detail={"per_seed": per_seed},
    )


def e3_multi_pass_detection(n_passes: int = 6) -> ExperimentResult:
    """Do independent passes improve detection over a single pass?"""
    carries = [1.0, 0.6, 0.35, 1.0, 0.6, 0.8]
    cadences = [2.6, 2.8, 3.0, 2.4, 2.9, 2.7]
    passes, truth = [], ROUTE_ANOMALIES
    for i in range(n_passes):
        pp, truth, _ = _make_pass(
            100 + i,
            carry_gain=carries[i % len(carries)],
            step_freq_hz=cadences[i % len(cadences)],
            speed_mps=2.6 + 0.2 * (i % 3),
        )
        passes.append(pp)
    curve = {}
    for k in (1, 2, 3, 4, 6):
        if k > n_passes:
            continue
        dets, _bm = detect_multi_pass(passes[:k])
        ev = evaluate_detections(dets, truth)
        curve[k] = {**ev.as_dict(), "n_detections": len(dets)}
    dets, bm = detect_multi_pass(passes)
    return ExperimentResult(
        name="E3_multi_pass",
        summary={
            "passes_vs_f1": {k: round(v["f1"], 3) for k, v in curve.items()},
            "final_f1": round(curve[max(curve)]["f1"], 3),
            "final_precision": round(curve[max(curve)]["precision"], 3),
            "final_recall": round(curve[max(curve)]["recall"], 3),
            "bin_size_m": bm.bin_size_m,
        },
        detail={
            "curve": curve,
            "detections": [d.__dict__ for d in dets],
            "coverage_median": float(np.median(bm.coverage)),
        },
    )


MODAL_CADENCES = (2.35, 2.45, 2.55, 2.65, 2.9, 3.05, 3.15, 1.9)


def _modal_readings(f_mode: float, seed0: int, n_passes: int, span_m: float = 200.0):
    """Collect one modal reading per pass, gating passes blocked by cadence harmonics."""
    readings, blocked = [], 0
    for i in range(n_passes):
        f_step = MODAL_CADENCES[i % len(MODAL_CADENCES)]
        scn = SurfaceScenario(
            seed=seed0 + i,
            length_m=span_m,
            struct_mode_hz=f_mode,
            struct_mode_gain=0.35,
            step_freq_hz=f_step,
            step_freq_drift=0.02,
            anomalies=[],
        )
        trace, gps, _ = simulate_pass(scn)
        pp = process_pass(trace, gps)
        if harmonic_blocked(pp.f_step, f_mode, tol_hz=0.5):
            blocked += 1
            continue
        r = modal_signature(pp, f_range=(4.0, 9.0))
        if r:
            readings.append(r)
    return readings, blocked


def e4_modal_shift(baseline_hz: float = 6.2, damaged_frac: float = -0.08) -> ExperimentResult:
    """Can phone-carried runners track a bridge modal frequency across passes?

    Realistic version of the SHM claim: per-pass estimates are noisy, so the
    statistic is the *median across passes*, and passes whose cadence harmonics
    cover the mode are discarded up front.
    """
    damaged_hz = baseline_hz * (1 + damaged_frac)
    base, base_blocked = _modal_readings(baseline_hz, 200, 8)
    dmg, dmg_blocked = _modal_readings(damaged_hz, 300, 8)
    base_hzs = [r.freq_hz for r in base]
    dmg_hzs = [r.freq_hz for r in dmg]
    shift, alarm = (
        track_modal_shift(base, ModalReading(freq_hz=float(np.median(dmg_hzs)), zeta=None))
        if base and dmg
        else (float("nan"), False)
    )
    per_pass_shifts = [track_modal_shift(base, r)[0] for r in dmg] if base else []
    return ExperimentResult(
        name="E4_modal_shift",
        summary={
            "true_baseline_hz": baseline_hz,
            "estimated_baseline_hz": round(float(np.median(base_hzs)), 3) if base_hzs else None,
            "baseline_per_pass_std_hz": round(float(np.std(base_hzs)), 3) if base_hzs else None,
            "true_damaged_hz": round(damaged_hz, 3),
            "estimated_damaged_hz": round(float(np.median(dmg_hzs)), 3) if dmg_hzs else None,
            "true_shift_frac": damaged_frac,
            "estimated_shift_frac": round(shift, 4),
            "alarm_at_2pct": alarm,
            "passes_blocked_by_cadence_harmonics": base_blocked + dmg_blocked,
            "passes_used": len(base_hzs) + len(dmg_hzs),
            "single_pass_shift_spread_frac": (
                round(float(np.std(per_pass_shifts)), 4) if per_pass_shifts else None
            ),
        },
        detail={
            "baseline_readings_hz": [round(x, 3) for x in base_hzs],
            "damaged_readings_hz": [round(x, 3) for x in dmg_hzs],
            "baseline_damping": [round(r.zeta, 4) if r.zeta else None for r in base],
        },
    )


def e5_robustness(seed: int = 7) -> ExperimentResult:
    """Sensitivity to sampling rate, carry position and GPS noise."""
    rows = []
    for fs in (50.0, 100.0, 200.0):
        pp, truth, _ = _make_pass(seed, fs=fs)
        ev = evaluate_detections(detect_single_pass(pp), truth)
        rows.append({"variant": f"fs={fs:g}Hz", **ev.as_dict()})
    for gain, label in ((1.0, "hand"), (0.6, "pocket"), (0.35, "backpack")):
        pp, truth, _ = _make_pass(seed, carry_gain=gain)
        ev = evaluate_detections(detect_single_pass(pp), truth)
        rows.append({"variant": f"carry={label}", **ev.as_dict()})
    for gps_noise in (1.0, 3.0, 8.0):
        pp, truth, _ = _make_pass(seed, gps_noise_m=gps_noise)
        ev = evaluate_detections(detect_single_pass(pp), truth)
        rows.append({"variant": f"gps_noise={gps_noise:g}m", **ev.as_dict()})
    for noise in (0.06, 0.2, 0.5):
        pp, truth, _ = _make_pass(seed, noise_rms=noise)
        ev = evaluate_detections(detect_single_pass(pp), truth)
        rows.append({"variant": f"sensor_noise={noise:g}", **ev.as_dict()})
    return ExperimentResult(
        name="E5_robustness",
        summary={r["variant"]: round(r["f1"], 3) for r in rows},
        detail={"rows": rows},
    )


def e6_sample_rate_gate(seeds: tuple[int, ...] = (1, 2, 3, 4, 5, 6, 7, 8, 9, 10)) -> ExperimentResult:
    """How detection degrades below the 100 Hz requirement, per rate.

    E5 sweeps the rate on a single seed and reports F1 only, which cannot
    distinguish "the detector starts lying" from "the detector stops seeing".
    Averaging precision and recall separately over seeds does, and that is what
    the capture gate grades on: sub-100 Hz captures lose recall while their
    precision stays at or above the 100 Hz baseline, so they are reported as
    degraded rather than withheld. The rates bracket both gate boundaries -
    ``FLOOR_FS_HZ`` (35/40/41) and ``MIN_FS_HZ`` (90/99/100) - because a
    threshold is only justified by what happens on either side of it.
    """
    rows = []
    for fs in (35.0, 40.0, 41.0, 45.0, 50.0, 60.0, 75.0, 90.0, 99.0, 100.0, 200.0):
        evs = []
        for s in seeds:
            pp, truth, _ = _make_pass(s, fs=fs)
            evs.append(evaluate_detections(detect_single_pass(pp), truth))
        rows.append(
            {
                "fs_hz": fs,
                "precision": round(float(np.mean([e.precision for e in evs])), 3),
                "recall": round(float(np.mean([e.recall for e in evs])), 3),
                "f1": round(float(np.mean([e.f1 for e in evs])), 3),
                "false_positives": int(sum(e.fp for e in evs)),
            }
        )
    return ExperimentResult(
        name="E6_sample_rate_gate",
        summary={f"fs={r['fs_hz']:g}Hz": f"P {r['precision']:.2f} / R {r['recall']:.2f}" for r in rows},
        detail={"rows": rows, "seeds": list(seeds)},
    )


ALL_EXPERIMENTS = {
    "e1": e1_cadence_separation,
    "e2": e2_single_pass_detection,
    "e3": e3_multi_pass_detection,
    "e4": e4_modal_shift,
    "e5": e5_robustness,
    "e6": e6_sample_rate_gate,
}


def run_all(out_dir: Path | None = None) -> dict:
    results = {}
    for key, fn in ALL_EXPERIMENTS.items():
        res = fn()
        results[res.name] = {"summary": res.summary, "detail": res.detail}
        print(f"[{key}] {res.name}: {json.dumps(res.summary, default=str)}")
    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "results.json").write_text(json.dumps(results, indent=2, default=str))
    return results


def _fmt(det: list[Detection]) -> str:
    return ", ".join(f"{d.direction}@{d.peak_m:.0f}m(z={d.score:.1f})" for d in det)
