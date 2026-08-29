"""CLI: ``python -m bridge.cli run|demo|plot``."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .detect import detect_single_pass, score_pass
from .experiments import ALL_EXPERIMENTS, ROUTE_ANOMALIES, run_all
from .pipeline import process_pass
from .synth import SurfaceScenario, simulate_pass

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "docs" / "results"


def cmd_run(args: argparse.Namespace) -> int:
    out = Path(args.out) if args.out else DEFAULT_OUT
    if args.experiment == "all":
        run_all(out)
        return 0
    res = ALL_EXPERIMENTS[args.experiment]()
    print(json.dumps({res.name: res.summary}, indent=2, default=str))
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    scn = SurfaceScenario(seed=args.seed, anomalies=list(ROUTE_ANOMALIES))
    trace, gps, truth = simulate_pass(scn)
    pp = process_pass(trace, gps)
    sc = score_pass(pp)
    dets = detect_single_pass(pp)
    print(f"cadence: {pp.f_step * 60:.1f} spm   windows: {pp.n_windows}   footfalls: {pp.footfalls.size}")
    print("ground truth:", [(a.kind, a.start_m, a.end_m) for a in truth])
    for d in dets:
        print(
            f"  detected {d.direction:12s} {d.start_m:6.1f}-{d.end_m:6.1f} m "
            f" peak {d.peak_m:6.1f} m  z={d.score:.2f}"
        )
    print(f"max |score| = {np.max(np.abs(sc.signed)):.2f}")
    return 0


def cmd_plot(args: argparse.Namespace) -> int:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    scn = SurfaceScenario(seed=args.seed, anomalies=list(ROUTE_ANOMALIES))
    trace, gps, truth = simulate_pass(scn)
    pp = process_pass(trace, gps)
    sc = score_pass(pp)
    out = Path(args.out) if args.out else DEFAULT_OUT
    out.mkdir(parents=True, exist_ok=True)

    fig, ax = plt.subplots(3, 1, figsize=(11, 8), sharex=True)
    ax[0].plot(pp.window_distance_m, np.interp(pp.window_t, pp.t, pp.vert), lw=0.6)
    ax[0].set_ylabel("vertical accel\n(m/s^2, sampled)")
    d_win = pp.window_distance_m
    ax[1].plot(d_win, pp.features["hf_frac"], lw=0.9, label="hf_frac (>20 Hz share of residual)")
    ax[1].set_yscale("log")
    ax[1].legend(loc="upper right", fontsize=8)
    ax[1].set_ylabel("residual feature")
    ax[2].plot(d_win, sc.signed, lw=1.0, color="k", label="signed robust z")
    ax[2].axhline(4.0, color="r", ls="--", lw=0.8)
    ax[2].axhline(-4.0, color="b", ls="--", lw=0.8)
    ax[2].set_ylabel("score")
    ax[2].set_xlabel("distance along route (m)")
    for a in ax:
        for gt in truth:
            a.axvspan(gt.start_m, gt.end_m, color="orange", alpha=0.2)
    ax[2].legend(loc="upper right", fontsize=8)
    fig.suptitle("bridge: single-pass surface anomaly scores (orange = ground truth)")
    fig.tight_layout()
    path = out / "single_pass_scores.png"
    fig.savefig(path, dpi=130)
    print(f"wrote {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bridge", description="Feet-as-a-sensor-network prototype")
    sub = p.add_subparsers(dest="cmd", required=True)

    pr = sub.add_parser("run", help="run feasibility experiments")
    pr.add_argument("experiment", choices=[*ALL_EXPERIMENTS.keys(), "all"], nargs="?", default="all")
    pr.add_argument("--out", default=None)
    pr.set_defaults(func=cmd_run)

    pd_ = sub.add_parser("demo", help="simulate one pass and print detections")
    pd_.add_argument("--seed", type=int, default=1)
    pd_.set_defaults(func=cmd_demo)

    pp_ = sub.add_parser("plot", help="render diagnostic figure")
    pp_.add_argument("--seed", type=int, default=1)
    pp_.add_argument("--out", default=None)
    pp_.set_defaults(func=cmd_plot)

    args = p.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
