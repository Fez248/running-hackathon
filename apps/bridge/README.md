# bridge — feet as a sensor network

Idea #4. Use the IMU + GPS of phones (and watches) carried by runners and walkers
to detect **surface anomalies** (loose paving slabs, mats, wet patches, loose
boards) and **structural vibration signatures** (modal frequency / damping of a
footbridge or boardwalk) from ordinary runs — no instrumentation of the structure.

## Layout

```
apps/bridge/
  src/bridge/synth.py        physically-motivated forward model + ground truth
  src/bridge/pipeline.py     resample -> vertical projection -> cadence -> residual -> windows
  src/bridge/detect.py       single-pass, multi-pass and modal-shift detectors
  src/bridge/evaluate.py     precision/recall/localization/AUC against ground truth
  src/bridge/experiments.py  E1-E5 feasibility experiments (seeded)
  src/bridge/cli.py          `run`, `demo`, `plot`
  tests/                     23 tests (pytest)
  docs/FEASIBILITY.md            feasibility study, findings, limitations, plan
  docs/SENSOR_RECORDING_STACK.md recording-stack investigation (RN vs native vs PWA, Garmin)
libs/imukit/                 shared, app-agnostic IMU/GPS primitives
```

## Run it

```bash
cd apps/bridge
pip install -e ../../libs/imukit -e '.[dev]'   # or: PYTHONPATH=src:../../libs/imukit/src
python -m pytest -q
python -m bridge.cli demo            # one simulated pass + detections
python -m bridge.cli run all         # E1-E5, writes docs/results/results.json
python -m bridge.cli plot            # docs/results/single_pass_scores.png
python -m ruff check . ../../libs/imukit
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
