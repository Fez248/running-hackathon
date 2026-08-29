# Bridge floor-imperfection MVP — real-world testing guide

How to take the `bridge` floor-imperfection MVP out of the simulator and test it on a real
pavement with a real phone, end to end: what to record, what the files must contain, what the
quality gate accepts, how to run the scan, how to read and file the result.

Everything here is derived from the code in this repository:
[`apps/bridge/src/bridge/ingest.py`](../apps/bridge/src/bridge/ingest.py) (parsing),
[`quality.py`](../apps/bridge/src/bridge/quality.py) (gate),
[`pipeline.py`](../apps/bridge/src/bridge/pipeline.py) (preprocessing),
[`detect.py`](../apps/bridge/src/bridge/detect.py) (scoring),
[`scan.py`](../apps/bridge/src/bridge/scan.py) (findings, outputs),
[`cli.py`](../apps/bridge/src/bridge/cli.py) (commands), plus
[`apps/bridge/docs/REAL_WORLD_TEST.md`](../apps/bridge/docs/REAL_WORLD_TEST.md) and
[`FLOOR_IMPERFECTION_MVP.md`](../apps/bridge/docs/FLOOR_IMPERFECTION_MVP.md), which this guide
operationalises.

Time budget: ~30 min of setup, then ~5 min per pass; a full calibration session (6 passes, two
carry positions, one planted defect) is one afternoon.

Status this guide is written against: every number the repo reports is still simulator-derived.
This test is the experiment that replaces them.

---

## 0. Install and smoke-test the toolchain (do this before going outside)

```bash
cd apps/bridge

# Option A — uv (used to validate this guide)
uv venv
uv pip install -e . -e ../../libs/imukit pytest ruff
.venv/bin/python -m pytest -q                 # expect: 35 passed
.venv/bin/ruff check . ../../libs/imukit      # expect: All checks passed!
.venv/bin/python -m bridge.cli scan --demo    # expect: verdict OK, 2 findings, exit 0

# Option B — pip in an environment of your own
pip install -e ../../libs/imukit -e '.[dev]'  # Python >= 3.10, numpy + scipy
python -m pytest -q
python -m bridge.cli scan --demo
```

`scan --demo` writes a Sensor Logger shaped export to `apps/bridge/samples/demo_pass/` (gitignored)
and reads it back through the *real* ingestion path, so a passing demo proves the parser, gate,
pipeline and output writers all work on this machine:

```
demo: wrote a Sensor Logger shaped export to .../apps/bridge/samples/demo_pass
source        .../apps/bridge/samples/demo_pass  (sensorlogger)
capture       200 Hz IMU, 133 s, jitter p95 0.0 ms, GPS 1.0 Hz @ 3.0 m, route 412 m
verdict       OK
gait          165 spm, 374 footfalls, 176 windows
findings      2
  #0 loose_or_broken_element       78.9-   85.9 m peak    81.5 m  z=10.01  conf=1.00 @ 51.501429,-0.124592
  #1 loose_or_broken_element      306.5-  321.0 m peak   315.1 m  z= 6.42  conf=1.00 @ 51.503459,-0.124608
vs truth      precision 1.00  recall 0.67  F1 0.80  loc err 5.8 m
```

If the demo does not print `verdict OK` with two findings, fix that before recording anything —
a failing demo means the environment, not the pavement, is the variable under test.

In the commands below, `python` means the interpreter of the environment you just created
(`.venv/bin/python` with option A), and all paths are relative to `apps/bridge`.

---

## 1. Sensor and recording setup

### 1.1 Phone app and streams

`load_recording()` auto-detects three layouts. Use one of the first two; the third is the escape
hatch for other hardware.

| Logger | Files the export must contain | Settings |
| --- | --- | --- |
| **Sensor Logger** (iOS/Android) | `TotalAcceleration.csv` **or** `Accelerometer.csv`, plus `Location.csv` | accelerometer 200 Hz, Location on, export as "Zip of CSVs" or a folder |
| **phyphox** (iOS/Android) | `Accelerometer.csv` + `Location.csv` (comma or semicolon separated) | use the *"Acceleration with g"* experiment, **not** "Linear Acceleration" |
| **anything else** | one accelerometer CSV + optional GPS CSV, passed with `--gps` | see the column contract in §2 |

File discovery is by stem, case- and space-insensitive
([`_find()`](../apps/bridge/src/bridge/ingest.py)), searched recursively:
accelerometer = `totalacceleration`, `accelerometeruncalibrated`, `accelerometer`,
`linearacceleration`, `accelerationwithoutg` (in that preference order);
GPS = `location`, `gps`, `locationgps`. So `TotalAcceleration.csv`, `Total Acceleration.csv` and
`total acceleration.csv` all work, but `accel_total.csv` does not — rename it or pass it directly
as a generic CSV.

### 1.2 The gravity requirement (the most common way to waste a field trip)

The accelerometer stream **must still contain gravity**. `gravity_split()` tracks the gravity
direction with a 0.4 Hz low-pass and projects onto it, which is what makes the result independent
of how the phone is carried. A linear-/user-acceleration stream is rejected by the gate:
`_dc_magnitude()` low-passes `|a|` below `GRAVITY_CUTOFF_HZ = 0.4` and requires the median to sit
inside `GRAVITY_BAND_G = (0.5, 2.0)` × `g`.

Practical translation:

- Sensor Logger: record **Total Acceleration** (it is `Accelerometer` + gravity). Recording only
  "Accelerometer" (linear) on iOS produces an unusable file.
- phyphox: "Acceleration with g".
- Any custom app: use the raw/uncalibrated accelerometer, not `userAcceleration` /
  `TYPE_LINEAR_ACCELERATION`.

Confusing filenames do not help you here: the gate looks at the physics, not the name.

### 1.3 Rates and route

| Parameter | Requirement | Source |
| --- | --- | --- |
| IMU sample rate | ≥ 100 Hz target, 200 Hz recommended; 41-100 Hz scanned as `degraded`, ≤ 40 Hz rejected | `MIN_FS_HZ`, `FLOOR_FS_HZ = 40`, `WARN_FS_HZ = 150` |
| GPS | required, with an accuracy column; ≥ 2 fixes; 1 Hz is enough | `assess()` fails without a track |
| GPS median accuracy | ≤ 3 m target, > 5 m rejected | `MAX_GPS_ERR_M`, `WARN_GPS_ERR_M` |
| Pass duration | ≥ 30 s | `MIN_DURATION_S` |
| Route length | 200–500 m, open sky, one direction, no backtracking | along-path distance must be monotone |
| Carry position | fixed for the whole pass (hand, armband, waist belt) | `gravity_split` assumes quasi-static orientation |

### 1.4 Field protocol per pass

1. Pick a 200–500 m stretch away from tall buildings, containing at least one **known** defect:
   a rocking paving slab, a broken kerb, a loose board, a doormat, a gravel or wet patch.
2. Ground-truth it *before* recording: photograph it, drop a pin (or record a GPS waypoint), and
   measure the along-route distance from your start point with a tape or a counted pace so you can
   compare against `peak_m`, not only against lat/lon.
3. Start the recording, **stand still ~5 s**, walk/run the route at a steady cadence, **stand still
   ~5 s**, stop. Do not re-pocket the phone mid-pass.
4. Repeat 3–6 times. Include:
   - one pass at a different cadence (walk vs run),
   - one pass with a different carry position,
   - one **negative control** pass over a stretch with no known defect.
5. Export each pass to its own directory or `.zip`, named so the metadata is not lost, e.g.
   `~/recordings/2026-08-29_millerstr_run1_hand/`.

### 1.5 Metadata to record by hand (nothing in the file carries it)

The scan output records only what the phone wrote. Keep a `notes.md` (or a row per pass in a
sheet) next to the recordings with: date/time, route name + start point, direction, phone model and
OS version, logger app + version, configured sample rate, carry position, gait (walk/run) and
cadence if known, weather/surface wetness, the defect list with type and measured along-route
distance, and whether the pass is a negative control. Without those, a finding is not
reproducible, and per-device sensor filtering (limitation #3 in the MVP report) cannot be audited.

---

## 2. File and schema requirements

`read_table()` reads any delimited text table (`,`, `;`, tab — sniffed from the header line), strips
a UTF-8 BOM, normalises headers by lower-casing and dropping everything from the first `(`
(`"Acceleration x (m/s^2)"` → `acceleration x`), coerces cells to float (unparsable → NaN), then
`_clean()` drops non-finite rows and sorts by time.

**Accelerometer table** — one time column plus three axis columns:

| Field | Accepted header aliases (normalised) |
| --- | --- |
| time | `seconds elapsed` (preferred), `t`, `time s`, `time sec`, `time`, `times`, `timestamp` |
| x / y / z | `x`/`ax`/`accel x`/`acceleration x`/`accelerometer x`/`acc x` (and the y, z equivalents) |

**GPS table** — time, latitude, longitude, and (strongly recommended) accuracy:

| Field | Accepted header aliases |
| --- | --- |
| time | as above |
| lat | `lat`, `latitude` |
| lon | `lon`, `lng`, `longitude` |
| accuracy (m) | `accuracy m`, `accuracy`, `horizontalaccuracy`, `horizontal accuracy m`, `horizontal accuracy` |

Units and conventions the code assumes:

- acceleration in **m/s²** (the gravity band is checked against `G = 9.80665`);
- time in seconds, epoch-milliseconds (`> 1e11`) or epoch-nanoseconds (`> 1e15`) — `_seconds()`
  rescales automatically;
- **the accelerometer file defines t = 0**: the GPS track is shifted by the accelerometer's first
  timestamp, so both streams must come from the same recording session and share a clock (§3);
- size limits: 512 MB per CSV, 1 GB unpacked per `.zip`; `.zip` entries that escape the extraction
  directory are refused.

A minimal generic pair, if you write your own logger:

```csv
# accel.csv
t,ax,ay,az
0.000,0.12,-0.03,9.79
0.005,0.15,-0.02,9.83
```

```csv
# gps.csv
t,lat,lon,accuracy_m
0.0,52.520800,13.409500,3.0
1.0,52.520811,13.409530,3.0
```

Scan it with `python -m bridge.cli scan accel.csv --gps gps.csv`.

---

## 3. Calibration and synchronisation

- **Clock alignment.** Sensor Logger writes `seconds_elapsed` next to an epoch-ns `time`; both
  streams of one export share that clock, and `load_export_dir()` rebases GPS onto the
  accelerometer's `t0`. Never mix an accelerometer file from one recording with a GPS file from
  another: the along-path projection would place findings at the wrong distance with no warning.
- **Timestamp jitter.** `resample_uniform()` interpolates onto a uniform `fs_target = 200 Hz` grid,
  so mild jitter is handled; the report prints `jitter p95` in ms so you can see how bad it was.
- **Start/stop markers.** The ~5 s of standing still at both ends gives the cadence estimator and
  the stride template clean boundaries, and lets you confirm on inspection that the pass you
  scanned is the pass you walked.
- **Sensor calibration.** No per-device accelerometer calibration step exists or is needed: the
  detector scores each window against *this pass's own* robust baseline, so a constant scale or
  bias error cancels. What does not cancel is OS-level filtering of the 20–80 Hz band, which is why
  §1.5 asks for the phone model — repeat one pass per device to audit it.
- **Spatial calibration.** Localisation is GPS-bound (~5–7 m in the simulator). Walk a known
  distance and compare the printed `route N m` against the true length before trusting `peak_m`;
  hand-measured along-route distances are the ground truth to compare findings against.
- **Positioning of ground truth.** `position_at_distance()` inverts `peak_m` back to lat/lon along
  the smoothed GPS path, so a defect's *distance from the start* is the primary comparison and its
  lat/lon is derived.

---

## 4. Quality gate — concrete pass/fail checks

Run before any detection; on `unusable` the findings are **withheld** and the CLI exits `1`
([`assess()`](../apps/bridge/src/bridge/quality.py)).

| Check | Rejected (`unusable`, exit 1) | Warned (`degraded`, still scanned) |
| --- | --- | --- |
| IMU sample rate | `<= 40 Hz` (whole 20-45 Hz shock band above Nyquist) | `< 150 Hz`; `< 100 Hz` additionally warns that ~half the defects are missed (E6) |
| Pass duration | `< 30 s` | — |
| Gravity present | median low-passed `\|a\|` outside `0.5 g … 2.0 g` | — |
| GPS track | missing, or `< 2` fixes | — |
| GPS accuracy column | — | absent (localisation error unknown) |
| Median GPS accuracy | `> 5 m` | `> 3 m` |
| Sample dropouts | — | `> 2 %` of gaps are `> 3×` nominal |
| Clipping | — | `> 0.1 %` of samples at `≥ 4 g` |

Consequences of the verdict, from `scan.py`: confidence multiplier `ok = 1.0`,
`degraded = 0.6`, `unusable = 0.0` (no findings at all). Treat `ok`, or `degraded` carrying only
the sample-rate/GPS-accuracy warning, as analysable; anything else means re-record.

What a rejection looks like (reproduce it with a deliberately bad demo capture):

```bash
python -m bridge.cli scan --demo --demo-fs 35 --sample-dir samples/bad_pass; echo "exit=$?"
```

```
verdict       UNUSABLE
  ! IMU sampled at 35 Hz; at or below 40 Hz the whole 20-45 Hz shock band is above Nyquist, so there is nothing to detect
  note: capture failed the quality gate; findings are withheld, fix the capture first
exit=1
```

A 50 Hz pass, by contrast, is scanned and reported as `degraded`: E6 shows a slow capture
loses recall rather than precision, so its findings are kept — with a note that an *empty*
result from such a pass is not evidence of a sound surface.

Same shape for a missing GPS track — scanning the accelerometer CSV alone is rejected:

```bash
python -m bridge.cli scan samples/demo_pass/TotalAcceleration.csv; echo "exit=$?"
# verdict UNUSABLE — "no usable GPS track: findings cannot be placed along the route" ; exit=1
```

---

## 5. Preprocessing (what happens to your recording, in order)

`process_pass()` in [`pipeline.py`](../apps/bridge/src/bridge/pipeline.py):

1. **Resample** to a uniform 200 Hz grid (`resample_uniform`) — phone timestamps jitter and drop.
2. **Vertical projection** (`gravity_split`, 0.4 Hz gravity tracker) — carry-position invariance;
   this is the step that needs gravity in the stream.
3. **Cadence + footfalls** (`estimate_step_frequency`, `detect_footfalls`, `stride_segments`) —
   the report's `spm` / `footfalls` numbers come from here.
4. **Stride-template suppression** (`suppress_cadence`) — a median phase-normalised stride
   template (96 phase bins) is amplitude-fitted per stride and subtracted, so what remains is the
   part of each footstrike that does not look like your normal stride.
5. **Band-limit the residual** to 4–80 Hz (below: template mismatch, above: sensor noise).
6. **Window** into 1.5 s windows, 0.75 s hop, and compute spectral/shock features per window
   (bands `gait 1–6`, `struct 6–20`, `shock 20–45`, `hf 45–90 Hz`).
7. **Project each window onto along-path distance** from the (5 s-smoothed) GPS track.
8. **Score** (`detect_single_pass`): robust z per window against the pass's own baseline, in log
   space for heavy-tailed features; contiguous runs of `≥ 2` windows over the threshold are merged
   when within `6 m`, and split into `excess` (rattling) and `attenuation` (absorbing) panels.

Nothing here needs configuring for a field test; the only knob is `--threshold` (§6).

---

## 6. Running a scan on real data, end to end

```bash
cd apps/bridge

# 1. Export directory as produced by the logger
python -m bridge.cli scan ~/recordings/2026-08-29_millerstr_run1_hand

# 2. The same export zipped
python -m bridge.cli scan ~/recordings/2026-08-29_millerstr_run1_hand.zip

# 3. Generic CSVs
python -m bridge.cli scan accel.csv --gps gps.csv

# 4. Keep the full result (quality metrics + findings) for the record
python -m bridge.cli scan ~/recordings/run1 --out results/run1.json

# 5. GeoJSON, ready to import as Sidewalk Map ROUGH_SURFACE reports
python -m bridge.cli scan ~/recordings/run1 --out results/run1.geojson --format geojson

# 6. CSV, one row per finding
python -m bridge.cli scan ~/recordings/run1 --out results/run1.csv --format csv

# 7. More recall at the cost of precision (default 3.0; the MVP report measured
#    2.5 -> recall 1.00, precision 0.60 on the demo)
python -m bridge.cli scan ~/recordings/run1 --threshold 2.5
```

Batch a session and keep the exit codes:

```bash
cd apps/bridge
for pass_dir in ~/recordings/2026-08-29_*/; do
  name=$(basename "$pass_dir")
  python -m bridge.cli scan "$pass_dir" --out "results/$name.json" | tee "results/$name.txt"
  echo "$name exit=$?"
done
```

Exit codes: `0` = capture usable (with or without findings), `1` = capture rejected by the gate,
`2` = no recording path and no `--demo`.

---

## 7. Expected outputs

Printed report (field order fixed by `format_report()`): `source`, `capture`, `verdict`, then `!`
problems / `~` warnings, then `gait`, `findings`, one line per finding, then `note:` lines.

```
source        /home/you/recordings/run1  (sensorlogger)
capture       200 Hz IMU, 133 s, jitter p95 0.0 ms, GPS 1.0 Hz @ 3.0 m, route 412 m
verdict       OK
gait          165 spm, 374 footfalls, 176 windows
findings      2
  #0 loose_or_broken_element       78.9-   85.9 m peak    81.5 m  z=10.01  conf=1.00 @ 51.501429,-0.124592
```

Finding fields: `kind` is `loose_or_broken_element` (rattling/impact-heavy: loose slab, broken
kerb, loose board) or `compliant_or_absorbing` (soft/absorbing: mat, gravel, wet or deformable
patch); `start_m`–`end_m` is the extent along the route, `peak_m` the strongest window, `z` the
robust z against this pass's baseline, `conf` that strength discounted by the capture verdict, and
`lat,lon` the peak inverted back onto the GPS path.

`--format csv` (verified on the demo export):

```csv
index,kind,start_m,end_m,peak_m,score,confidence,lat,lon
0,loose_or_broken_element,78.9,85.9,81.5,10.01,1.0,51.5014285,-0.1245919
1,loose_or_broken_element,306.5,321.0,315.1,6.42,1.0,51.5034593,-0.1246077
```

`--format geojson` — a `FeatureCollection` of points, each with `kind`, `sidewalkMapKind:
"ROUGH_SURFACE"`, `description`, `distance_m`, `extent_m`, `score`, `confidence`, and
`properties.quality` = the verdict at collection level. `--format json` additionally carries the
whole `quality` block (`fs_hz`, `jitter_ms`, `dropout_frac`, `duration_s`, `gravity_present`,
`clipping_frac`, `gps_rate_hz`, `gps_accuracy_m`, `route_length_m`, `verdict`, `problems`,
`warnings`, `usable`) — that is the artefact to archive per pass.

### Pass/fail criteria for the field test as a whole

Across the repetitions of §1.4:

- the known defect produces a finding on **most** passes, with `peak_m` within ~10 m of the
  hand-measured distance (GPS-limited, not algorithm-limited);
- the polarity matches the physical cause (rattling → `loose_or_broken_element`, soft/absorbing →
  `compliant_or_absorbing`);
- the **negative-control** pass and the defect-free remainder of each route stay quiet. A handful
  of findings per few hundred metres of ordinary pavement is the failure mode that makes the MVP
  undeployable, and is the thing this test exists to detect;
- results survive a change of carry position and of gait.

Write the outcome (per-pass counts, distances, and the `--out` JSON) into
[`apps/bridge/docs/FLOOR_IMPERFECTION_MVP.md`](../apps/bridge/docs/FLOOR_IMPERFECTION_MVP.md) —
until that section is filled in with real recordings, every number in this repository is simulated.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no Accelerometer.csv / TotalAcceleration.csv found` | export layout not recognised by stem | rename to `TotalAcceleration.csv` / `Accelerometer.csv`, or pass the CSV directly with `--gps` |
| `missing time or x/y/z acceleration columns; found [...]` | headers outside the alias list | rename the columns to `t,ax,ay,az` (the message lists what was parsed) |
| `DC \|a\| is 0.0x m/s², not ~9.8: gravity removed` | linear-/user-acceleration stream | re-record with Total Acceleration / "Acceleration with g" |
| `IMU sampled at NN Hz; at or below 40 Hz ...` | logger default rate too low | set 200 Hz in the app; on Android some apps cap per-sensor rate — check the export, not the UI |
| `no usable GPS track` | GPS not enabled, or GPS file not exported/found | enable Location in the logger, export `Location.csv`, or pass `--gps` |
| `median GPS accuracy N m` rejection | urban canyon / cold GPS start | wait ~1 min outdoors before starting, pick an open route, re-record |
| `pass is NN s; ... needs ≥30 s` | pass too short | walk a longer stretch (200 m+) |
| `% of sample gaps are >3x nominal` | logger throttled by the OS (screen off, background) | keep the screen on and the app foregrounded, disable battery optimisation |
| `% of samples at ≥4g — accelerometer range clipping` | hard running with a low-range accelerometer setting | raise the range if the app exposes it; treat the pass as degraded |
| `no window exceeded z=3.0` | uniform surface, or defect too small/soft | retry with `--threshold 2.5`; expect more false positives |
| Findings everywhere on ordinary pavement | non-fixed carry position, or route with no nominal baseline | keep the phone in one position; pick a route that is mostly normal surface |
| Findings at the right distance but wrong lat/lon | backtracking or a stop-and-return route | scan one-direction passes only (along-path distance must be monotone) |
| `.zip: entry ... escapes the extraction directory` / size-limit errors | untrusted or oversized archive | unzip manually and scan the directory; split very long recordings |
| Defect found, but as the wrong `kind` | polarity → cause mapping is a forward-model hypothesis, not a validated classifier | record it as an observation; it is exactly what this test should measure |

Diagnostics: `python -m bridge.cli plot` renders the vertical acceleration, the residual `hf_frac`
feature and the signed robust z against distance (simulated pass) to
`apps/bridge/docs/results/single_pass_scores.png` — useful for seeing what a z of 3 versus 10 looks
like before interpreting your own numbers. `python -m bridge.cli run all` re-runs the E1–E5
feasibility experiments behind the thresholds above.

---

## 9. Safety and field-test cautions

- **The pavement is not a lab.** Anyone running while operating a phone is distracted; prefer
  walking passes for the first session, keep the phone stowed in an armband/belt (which is also
  what the pipeline prefers), and never look at the screen while moving.
- **Two people are better than one.** One walks the pass, one manages ground truth and traffic
  awareness. Do not step into the carriageway to reach a defect.
- **Do not create the defect.** Test on imperfections that already exist, or on a removable object
  you own (a doormat, a board) placed on private ground with permission — never loosen a slab, and
  never leave an object that could trip a passer-by. Remove it immediately after the pass.
- **Traffic, cyclists, and works.** Fenced-off roadworks are a legitimate Sidewalk Map report but
  not a place to walk a calibration route; scan around them.
- **Weather.** Wet/icy surfaces are a valid `compliant_or_absorbing` target but a slip risk; do not
  run them, and note the condition in the metadata.
- **Privacy.** A recording is a GPS trace of a person: `Location.csv` reveals home/start points, so
  trim the beginning/end, and keep raw exports out of the repository — only `apps/bridge/samples/`
  is gitignored, so store recordings outside the checkout (e.g. `~/recordings/`) and check
  `git status` before committing. Share only the derived findings. Do not record video of bystanders for ground truth; photos
  of the surface are enough.
- **Devices.** Battery drain at 200 Hz logging plus GPS is significant; a phone that dies mid-pass
  produces a truncated file that the `< 30 s` gate will reject anyway.
- **Interpretation.** A finding says "different from the rest of this route", not "3 cm lip,
  impassable for a wheelchair". Do not publish findings as accessibility facts to Sidewalk Map
  users without a human check of the location.
