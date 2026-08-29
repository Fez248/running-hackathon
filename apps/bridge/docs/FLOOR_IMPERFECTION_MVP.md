# Floor imperfection detection — MVP viability report

Question: **can a phone carried by a runner or walker find imperfections in the
floor/pavement it moves over, with hardware that exists today?**

[FEASIBILITY.md](FEASIBILITY.md) answered the *algorithmic* half in simulation:
stride-template suppression recovers the surface response, and a robust z-score
on the residual localizes anomalies to ~7 m. It left the *practical* half open —
that study never touched a file a real phone can produce, so nothing in it could
be run against a recording.

This MVP closes that half. It is one command that takes a recording exported by
an off-the-shelf logging app and returns geo-located findings, with a capture
quality gate in front of it.

```
recording (Sensor Logger / phyphox / CSV)
  -> ingest        parse, unify clocks, build ImuTrace + GpsTrack
  -> quality gate  ≥50 Hz (≥100 to be ungraded)? gravity? GPS ≤3 m? ≥30 s? -> verdict
  -> pipeline      cadence suppression -> residual -> windowed features
  -> detect        robust z, excess / attenuation panels
  -> findings      distance + lat/lon + confidence -> JSON / CSV / GeoJSON
```

## Run it

```bash
cd apps/bridge
pip install -e ../../libs/imukit -e '.[dev]'

python -m bridge.cli scan --demo                        # simulated recording, end to end
python -m bridge.cli scan ~/Downloads/2026-08-29_run    # a real Sensor Logger export
python -m bridge.cli scan run.zip --out found.geojson --format geojson
python -m bridge.cli scan accel.csv --gps gps.csv --threshold 2.5
```

Exit code is 0 when the capture passes the quality gate, 1 when it does not.

## What the demo shows

`scan --demo` renders a 400 m pass with three planted imperfections (loose slab
80-88 m, wet mat 180-205 m, loose board 300-312 m), writes it out as a Sensor
Logger shaped export, then reads that export back and scans it. Committed output:
[results/demo_scan.json](results/demo_scan.json).

| demo capture | verdict | findings | precision | recall | localization |
| --- | --- | --- | --- | --- | --- |
| 200 Hz, GPS 3 m | ok | 2 | 1.00 | 0.67 | 5.8 m |
| 100 Hz, GPS 3 m | degraded | 2 | 1.00 | 0.67 | 5.1 m |
| 200 Hz, `--threshold 2.5` | ok | 5 | 0.60 | 1.00 | 5.7 m |
| 60 Hz, GPS 3 m | degraded | 2 | 1.00 | 0.67 | 10.6 m |
| 40 Hz, GPS 3 m | **unusable** | withheld | — | — | — |
| 200 Hz, GPS 8 m | **unusable** | withheld | — | — | — |

Two things are worth reading off this table. First, the file round-trip is
lossless: `scan --demo` reproduces the in-memory `demo` command's detections
(z = 10.01 at 81.5 m, z = 6.42 at 315.1 m) exactly, so CSV export is not where
the signal dies. Second, the missing detection at the default threshold is the
wet mat in both rows — the attenuation class stays the weak one, and buying it
back with `--threshold 2.5` costs two false positives, exactly as E2 predicted.

## Viability verdict

**Viable, conditionally, and now testable.** Nothing about the sensing chain is
beyond current hardware: 200 Hz IMU logging with GPS is a free app on a stock
phone, and the whole scan of a 133 s pass runs in ~0.6 s on a laptop, i.e. it
could run on the phone itself. What is *not* yet established is the real-world
SNR — every number above still comes from the forward model, and a simulator
written by the author of the detector is the classic way to get an optimistic
answer.

The honest summary: the engineering is viable, the physics is unproven, and the
gate between the two is one afternoon of recording (Phase 1 below).

## Assumptions

1. The logging app delivers ≥100 Hz accelerometer data **with gravity** and
   trustworthy timestamps, plus GPS with an accuracy column.
2. The route is mostly nominal surface: the robust baseline is the route itself,
   so a uniformly bad pavement scores as uniformly fine.
3. Imperfections are compact (metres) and the pass is ≥30 s.
4. Carry position is fixed within a pass; between passes it may change.
5. Along-path distance from GPS is monotone — one direction, no backtracking.
6. The mapping from detector polarity to a physical cause
   (`excess` -> loose/broken, `attenuation` -> compliant/absorbing) is a
   hypothesis from the forward model, not a validated classifier.

## Limitations

* **Still zero real recordings.** The ingest path is exercised by synthetic data
  shaped like a real export, which validates parsing and clock handling, not
  physics.
* Findings are single-pass. The multi-pass consensus mode (`detect_multi_pass`)
  is the recommended operating mode in the feasibility study and is **not** wired
  into `scan` yet — one pass, one route, one verdict.
* Localization is GPS-bound at ~5-7 m, coarser than the paving slab it is trying
  to name.
* The quality gate reads the GPS accuracy the phone *reports*, which is an
  optimistic estimate in urban canyons.
* No severity estimate: a finding says "different from the rest of this route",
  not "3 cm lip, impassable for a wheelchair", which is what Sidewalk Map
  ultimately needs.
* Attenuation-type imperfections (mats, gravel, wet patches) sit near the
  threshold and are the first thing lost.

## Next experiments

1. **Calibration walk (blocking, one afternoon).** One 300-400 m route, one
   movable planted defect (a loose board, a doormat), 6 passes, 2 carry
   positions, ground truth by GPS waypoint + video. Run `scan` on each pass
   unchanged: this is now a single command per pass, so the experiment is a data
   collection exercise, not a coding one.
2. **Measure the real SNR** of the residual in the 20-80 Hz band around the
   planted defect versus the rest of the route. This single number decides
   whether single-pass detection survives contact with reality.
3. **Per-device audit.** Repeat one pass on 3-4 phone models to see whether OS
   sensor filtering attenuates the band the whole method depends on.
4. **Wire multi-pass into `scan`** (`scan --passes dir1 dir2 ...`) once >1 real
   recording of the same route exists, and compare against the single-pass F1.
5. **Severity model.** Correlate score with a physical measurement (lip height in
   mm, measured by hand) to turn a z-score into something a wheelchair user can
   act on — the point where this stops being an anomaly detector and starts being
   a Sidewalk Map data source.
