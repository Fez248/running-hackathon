# Real-world test: recording a pass and scanning it

Everything measured so far is simulator-derived (see
[FLOOR_IMPERFECTION_MVP.md](FLOOR_IMPERFECTION_MVP.md)). This is the protocol for
the experiment that decides whether floor imperfection detection works off a real
phone: one calibration walk/run over a route with a *known* anomaly, scanned with
`bridge scan`, checked against where the anomaly actually is.

Budget: ~30 min of setup plus one 3-5 minute pass per repetition.

## 1. Prerequisites

```bash
git clone https://github.com/Fez248/running-hackathon
cd running-hackathon/apps/bridge
pip install -e ../../libs/imukit -e '.[dev]'   # Python ≥3.10, numpy + scipy only
python -m bridge.cli scan --demo               # smoke test, needs no hardware
```

On the phone, any logger that writes CSV at ≥100 Hz works. Verified layouts:

| App | Files to export | Notes |
| --- | --- | --- |
| Sensor Logger (iOS/Android) | `TotalAcceleration.csv` + `Location.csv` | set the accelerometer to 200 Hz, enable Location; export "Zip of CSVs" |
| phyphox (iOS/Android) | `Accelerometer.csv` + `Location.csv` | "Acceleration with g" experiment, not "Linear Acceleration" |
| anything else | `t,ax,ay,az` CSV + optional `t,lat,lon[,accuracy_m]` CSV | pass the GPS file with `--gps` |

**Use the accelerometer stream that still contains gravity.** A
linear-acceleration / user-acceleration stream is rejected: the vertical
projection is what makes the result independent of how the phone is carried.

## 2. Recording a pass

1. Pick a ~200-500 m route in the open (GPS accuracy degrades badly next to tall
   buildings), containing at least one known imperfection: a rocking paving slab,
   a doormat, a loose board, a wet patch. Note its position — a photo plus a pin
   dropped in any maps app is enough.
2. Carry the phone the same way for the whole pass (hand, armband or waist belt;
   a loose pocket adds swing noise but still works). Do not re-pocket mid-pass.
3. Start the recording, stand still for ~5 s, walk/run the route at a steady
   cadence, stand still ~5 s, stop the recording. Keep the pass ≥30 s.
4. Repeat 3-5 times, ideally including one pass that deliberately avoids the
   anomaly (a negative control) to see whether it produces a finding anyway.
5. Export and copy to the machine, e.g. `~/Downloads/2026-08-29_run/` or a `.zip`.

## 3. Acceptance checks (the quality gate)

`bridge scan` prints a verdict before any finding, and **withholds findings and
exits 1** when the capture is unusable — a detection run on a bad recording is
evidence about the recording, not about the idea. Implemented in
[`src/bridge/quality.py`](../src/bridge/quality.py):

| Check | Unusable | Degraded (still scanned) |
| --- | --- | --- |
| IMU sample rate | < 50 Hz (20-45 Hz shock band entirely above Nyquist) | < 150 Hz (200 Hz keeps the 20-80 Hz shock band); < 100 Hz also warns that ~half the defects are missed (E6) |
| Pass duration | < 30 s | — |
| Gravity in the stream | DC \|a\| outside 0.5-2.0 g | — |
| GPS track | missing, or fewer than 2 fixes | no accuracy column |
| Median GPS accuracy | > 5 m (E5: F1 0.00 at 8 m) | > 3 m |
| Sample dropouts | — | > 2% of gaps are >3x nominal |
| Clipping | — | > 0.1% of samples at ≥4 g |

A pass is worth analysing when the verdict is `OK` (or `DEGRADED` with only the
sample-rate or accuracy warning) — otherwise fix the capture and walk it again.

A 50-100 Hz capture is graded, not rejected: E6 shows precision holds at those
rates while recall roughly halves, so the findings it does report are as
trustworthy as a fast capture's and are emitted with the usual `degraded`
confidence — but an *empty* result from such a pass says nothing about the
surface, and `scan` says so in a note.

## 4. Scanning

```bash
cd apps/bridge

python -m bridge.cli scan ~/Downloads/2026-08-29_run                    # export directory
python -m bridge.cli scan ~/Downloads/run.zip                           # zipped export
python -m bridge.cli scan accel.csv --gps gps.csv                       # generic CSVs

# Write findings out; geojson drops straight onto the Sidewalk Map as ROUGH_SURFACE points.
python -m bridge.cli scan run.zip --out found.geojson --format geojson
python -m bridge.cli scan run.zip --out found.json                      # full result + quality metrics
python -m bridge.cli scan run.zip --threshold 2.5                       # more recall, more false positives
```

Exit code `0` = capture usable (with or without findings), `1` = capture rejected.

## 5. Reading the result

```
source        /home/you/Downloads/2026-08-29_run  (sensorlogger)
capture       200 Hz IMU, 133 s, jitter p95 0.0 ms, GPS 1.0 Hz @ 3.0 m, route 412 m
verdict       OK
gait          165 spm, 374 footfalls, 176 windows
findings      2
  #0 loose_or_broken_element   78.9-  85.9 m peak   81.5 m  z=10.01  conf=1.00 @ 51.501429,-0.124592
```

`loose_or_broken_element` is a rattling/impact-heavy response (loose slab, broken
kerb, loose board); `compliant_or_absorbing` is a soft/absorbing one (mat, gravel,
wet or deformable patch). `z` is the robust z of the window against the pass's own
baseline, `conf` is that score discounted by capture quality.

The test passes if, across repetitions:

- the known anomaly produces a finding on **most passes**, its peak within ~10 m
  of the true position (GPS-limited, not algorithm-limited);
- the direction matches (rattling vs absorbing);
- the negative-control pass and the rest of the route stay quiet — a handful of
  findings per few hundred metres of ordinary pavement is the failure mode to
  watch for, since a false-positive-heavy scan is not deployable.

Record the outcome (counts, distances, `--out found.json`) in
[FLOOR_IMPERFECTION_MVP.md](FLOOR_IMPERFECTION_MVP.md); until that is filled in,
every number in this repo is simulated.
