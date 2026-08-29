# bridge — feet as a sensor network

Idea #4. Use the IMU + GPS of phones (and watches) carried by runners and walkers
to detect **surface anomalies** (loose paving slabs, mats, wet patches, loose
boards) and **structural vibration signatures** (modal frequency / damping of a
footbridge or boardwalk) from ordinary runs — no instrumentation of the structure.

## Layout

```
apps/bridge/
  src/bridge/ingest.py       real phone recordings (Sensor Logger / phyphox / CSV) -> traces
  src/bridge/quality.py      capture quality gate (sample rate, gravity, GPS accuracy)
  src/bridge/scan.py         one recording -> geo-located floor-imperfection findings
  src/bridge/synth.py        physically-motivated forward model + ground truth
  src/bridge/pipeline.py     resample -> vertical projection -> cadence -> residual -> windows
  src/bridge/detect.py       single-pass, multi-pass and modal-shift detectors
  src/bridge/evaluate.py     precision/recall/localization/AUC against ground truth
  src/bridge/experiments.py  E1-E6 feasibility experiments (seeded)
  src/bridge/cli.py          `scan`, `run`, `demo`, `plot`
  tests/                     35 tests (pytest)
  docs/FEASIBILITY.md            feasibility study, findings, limitations, plan
  docs/FLOOR_IMPERFECTION_MVP.md MVP viability report (recording -> findings)
  docs/REAL_WORLD_TEST.md        how to record a real pass and scan it (protocol + acceptance checks)
  docs/SENSOR_RECORDING_STACK.md recording-stack investigation (RN vs native vs PWA, Garmin)
libs/imukit/                 shared, app-agnostic IMU/GPS primitives
```

## Run it

```bash
cd apps/bridge
pip install -e ../../libs/imukit -e '.[dev]'   # or: PYTHONPATH=src:../../libs/imukit/src
python -m pytest -q
python -m bridge.cli scan --demo     # end-to-end on a generated recording
python -m bridge.cli doctor <rec>    # capture settings to change before the next pass
python -m bridge.cli demo            # one simulated pass + detections
python -m bridge.cli run all         # E1-E6, writes docs/results/results.json
python -m bridge.cli plot            # docs/results/single_pass_scores.png
python -m ruff check . ../../libs/imukit
```

## Scanning a recording for floor imperfections

`bridge scan` is the MVP that answers "is floor imperfection detection viable with
current technology": point it at a recording from an ordinary phone logging app and
it prints a capture-quality verdict followed by geo-located findings. See
[docs/FLOOR_IMPERFECTION_MVP.md](docs/FLOOR_IMPERFECTION_MVP.md) for measured demo
numbers, assumptions, limitations and the next experiments, and
[docs/REAL_WORLD_TEST.md](docs/REAL_WORLD_TEST.md) for the step-by-step protocol for
recording a real pass on a phone, the acceptance checks it must clear, and how to
read the result.

```bash
cd apps/bridge

# No hardware? Generate a Sensor Logger shaped recording and scan it end to end.
python -m bridge.cli scan --demo

# Before walking home: what to change about the recorder's settings.
python -m bridge.cli doctor ~/Downloads/2026-08-29_run.zip

# A real recording: an export directory, a .zip of one, or a bare CSV + GPS CSV.
python -m bridge.cli scan ~/Downloads/2026-08-29_run
python -m bridge.cli scan run.zip --out found.geojson --format geojson
python -m bridge.cli scan accel.csv --gps gps.csv --threshold 2.5
```

**Input.** Sensor Logger (`TotalAcceleration.csv` + `Location.csv`), phyphox
(`Accelerometer.csv` + `Location.csv`, comma or semicolon), or a generic CSV with a
time column plus x/y/z acceleration and an optional `t,lat,lon[,accuracy_m]` GPS CSV.
The accelerometer stream must still contain **gravity** - the vertical projection
needs it - and should be sampled at **>=100 Hz** with GPS accuracy **<=3 m**, the two
requirements E5 in the feasibility study derived. Sample rate is graded rather than
gating: 41-100 Hz is scanned as `degraded` because E6 shows precision there matches
or beats 100 Hz while recall roughly halves, and only at or below 40 Hz - where the
whole 20-45 Hz shock band is above Nyquist - is a recording refused.

**Output.** A printed report, plus `--out` in `json` (full result incl. quality
metrics), `csv`, or `geojson` (`ROUGH_SURFACE` points ready for the Sidewalk Map
report model). Findings carry an extent in metres along the route, a peak position
with lat/lon, a robust z score, a confidence discounted by capture quality, and a
kind: `loose_or_broken_element` (rattling) or `compliant_or_absorbing` (soft patch).
The exit code is 1 when the capture fails the quality gate, in which case findings
are withheld rather than reported at face value.

```
$ python -m bridge.cli scan --demo
source        samples/demo_pass  (sensorlogger)
capture       200 Hz IMU, 133 s, jitter p95 0.0 ms, GPS 1.0 Hz @ 3.0 m, route 412 m
verdict       OK
gait          165 spm, 374 footfalls, 176 windows
findings      2
  #0 loose_or_broken_element       78.9-   85.9 m peak    81.5 m  z=10.01  conf=1.00 @ 51.501429,-0.124592
  #1 loose_or_broken_element      306.5-  321.0 m peak   315.1 m  z= 6.42  conf=1.00 @ 51.503459,-0.124608
vs truth      precision 1.00  recall 0.67  F1 0.80  loc err 5.8 m
```

## Core idea in one paragraph

The vertical acceleration of a running phone is ~99% cadence: a quasi-periodic
body-motion waveform plus its harmonics. The surface response lives in the
transient tail of each footstrike, 3-4 orders of magnitude below the gait peaks in
energy. The pipeline estimates a **phase-normalized stride template** and
subtracts it stride-by-stride with a least-squares gain fit; the residual keeps
the part of each footstrike that does *not* look like this runner's normal stride,
which is what the surface and the structure contribute. Windowed features on that
residual (band energies, spectral shape, crest, kurtosis) are then compared to the
trace's own robust baseline (single pass) or to a per-bin consensus across passes
(multi pass), and projected onto GPS distance-along-path.

See [docs/FEASIBILITY.md](docs/FEASIBILITY.md) for measured results, assumptions,
limitations and the technical plan, and
[docs/SENSOR_RECORDING_STACK.md](docs/SENSOR_RECORDING_STACK.md) for how to
actually record the data on iPhone/Garmin hardware.
