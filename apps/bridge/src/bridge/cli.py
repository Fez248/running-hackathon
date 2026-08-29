"""CLI: ``python -m bridge.cli run|demo|plot|scan``."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from .detect import detect_single_pass, score_pass
from .evaluate import evaluate_detections
from .experiments import ALL_EXPERIMENTS, ROUTE_ANOMALIES, run_all
from .ingest import load_recording, write_export_dir
from .pipeline import process_pass
from .scan import format_report, scan_recording, write_output
from .synth import SurfaceScenario, simulate_pass

APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = APP_ROOT / "docs" / "results"
DEFAULT_SAMPLE_DIR = APP_ROOT / "samples" / "demo_pass"


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


def positive_float(text: str) -> float:
    value = float(text)
    if not np.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError(f"expected a finite positive number, got {text!r}")
    return value


def cmd_scan(args: argparse.Namespace) -> int:
    """Scan a real (or, with --demo, a simulated) recording for floor imperfections."""
    truth = None
    if args.demo:
        sample_dir = Path(args.sample_dir) if args.sample_dir else DEFAULT_SAMPLE_DIR
        scn = SurfaceScenario(seed=args.seed, anomalies=list(ROUTE_ANOMALIES), fs=args.demo_fs)
        trace, gps, truth = simulate_pass(scn)
        write_export_dir(sample_dir, trace, gps)
        print(f"demo: wrote a Sensor Logger shaped export to {sample_dir}")
        rec = load_recording(sample_dir)
    else:
        if not args.recording:
            print("error: pass a recording path, or --demo to generate one")
            return 2
        rec = load_recording(Path(args.recording), Path(args.gps) if args.gps else None)

    result, _pp = scan_recording(rec, threshold=args.threshold)
    print(format_report(result))

    if truth is not None and result.quality.usable:
        dets = detect_single_pass(_pp, threshold=args.threshold)
        ev = evaluate_detections(dets, truth)
        print("ground truth:", [(a.kind, a.start_m, a.end_m) for a in truth])
        loc = "n/a" if ev.mean_localization_error_m is None else f"{ev.mean_localization_error_m:.1f} m"
        print(
            f"vs truth      precision {ev.precision:.2f}  recall {ev.recall:.2f}  "
            f"F1 {ev.f1:.2f}  loc err {loc}"
        )

    if args.out:
        path = write_output(result, Path(args.out), args.format, client_scan_id=args.client_scan_id)
        print(f"wrote {path}")
        if args.format == "map":
            print("upload it with the map's “Import bridge scan” panel to create ROUGH_SURFACE reports")
    return 0 if result.quality.usable else 1


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

    ps = sub.add_parser("scan", help="scan a recorded pass for floor imperfections")
    ps.add_argument("recording", nargs="?", help="export dir, .zip, or accelerometer CSV")
    ps.add_argument("--gps", default=None, help="GPS CSV (t,lat,lon[,accuracy_m]) for a bare accel CSV")
    ps.add_argument("--demo", action="store_true", help="generate and scan a simulated recording")
    ps.add_argument("--demo-fs", type=positive_float, default=200.0, help="demo IMU sample rate (Hz)")
    ps.add_argument("--sample-dir", default=None, help="where --demo writes the generated export")
    ps.add_argument(
        "--threshold", type=positive_float, default=3.0, help="robust-z detection threshold"
    )
    ps.add_argument(
        "--format",
        choices=["json", "geojson", "csv", "map"],
        default="json",
        help="'map' writes the payload the Sidewalk Map scan.ingest endpoint accepts",
    )
    ps.add_argument("--out", default=None, help="write findings to this file")
    ps.add_argument(
        "--client-scan-id",
        default=None,
        help="idempotency key for --format map (default: content hash of the scan)",
    )
    ps.add_argument("--seed", type=int, default=1)
    ps.set_defaults(func=cmd_scan)

    pp_ = sub.add_parser("plot", help="render diagnostic figure")
    pp_.add_argument("--seed", type=int, default=1)
    pp_.add_argument("--out", default=None)
    pp_.set_defaults(func=cmd_plot)

    args = p.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
