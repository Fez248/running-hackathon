# Sensor data recording stack — technical investigation

Scope: how to actually *capture* the IMU/GPS data the bridge prototype consumes, on an iPhone
(± Garmin watch / HRM), at rates and with timestamp quality good enough for the pipeline in
<code>apps/bridge</code>. Companion to `FEASIBILITY.md` (which covers the signal processing).

All sources are primary vendor documentation unless stated. **Access date for every URL below:
2026-08-29.** Claims are tagged:

- **[doc]** — stated in the cited vendor documentation.
- **[inference]** — my reasoning from documented behaviour or general platform knowledge.
- **[validate]** — must be measured on the actual target hardware before being relied on.

---

## 0. What the pipeline needs from the recorder

Derived from `FEASIBILITY.md` and the E1–E5 experiment results:

| Phenomenon | Band of interest | Implied sample rate | Notes |
|---|---|---|---|
| Body motion / cadence | 1–6 Hz | ≥ 20 Hz | Removed by the stride-template step, not the target signal. |
| Footstep shock / surface response | 20–45 Hz | ≥ 100 Hz | Main discriminator for loose slabs / boards. |
| Slab rattle, high-frequency content | 45–90 Hz | ≥ 200 Hz | `hf_frac` feature; useful but not essential. |
| Structural modal peaks (footbridge) | 1–20 Hz (typ. 2–12 Hz) | ≥ 50 Hz | Needs *long*, stationary-ish records for frequency resolution, not high rate. |

Requirements that fall out of this:

- **Rate:** 100 Hz is the working minimum; 200 Hz is the target. E5 (synthetic) showed F1 0.5 at
  50 Hz vs 0.80–0.86 at 100–200 Hz — 50 Hz is not enough for the shock band.
- **Timestamps:** per-sample device timestamps, monotonic, with jitter small relative to the
  shortest feature (~5 ms at 200 Hz). The pipeline resamples onto a uniform grid
  (`imukit.preprocess.resample_uniform`), so *jitter is tolerable if it is measured*; what is not
  tolerable is samples arriving with a batch-arrival timestamp instead of a capture timestamp.
- **Gaps:** dropped samples must be *detectable*. A silently decimated stream biases the spectrum
  and would invalidate modal tracking.
- **Duration:** continuous minutes-long records, surviving screen lock / app backgrounding for a
  realistic run.
- **GPS:** 1 Hz locations with their own timestamps and horizontal accuracy per fix. E5 showed
  performance collapses at ~8 m GPS noise, so accuracy must be recorded to allow rejection.

---

## 1. Mobile sensor access comparison

### 1.1 iOS Core Motion (native, Swift)

- `CMMotionManager` provides accelerometer, gyroscope, magnetometer and fused device-motion
  streams; Apple explicitly advises creating **only one instance per app** **[doc]**
  (https://developer.apple.com/documentation/coremotion/cmmotionmanager).
- Rate is requested via `accelerometerUpdateInterval` (seconds); Apple documents that the *actual*
  interval is capped by the **maximum frequency supported by the hardware**, that this maximum is
  "usually at least 100 Hz", and that you should **inspect the timestamps of delivered samples to
  determine the true interval** **[doc]**
  (https://developer.apple.com/documentation/coremotion/cmmotionmanager/accelerometerupdateinterval,
  https://developer.apple.com/documentation/coremotion/getting-raw-accelerometer-events).
  → So the common "CoreMotion ≈ 100 Hz" assumption is **a documented floor, not a ceiling**.
  Higher rates (commonly cited 200 Hz, and higher for `CMDeviceMotion` on some devices) are
  plausible but device-dependent **[inference]** and must be **[validate]**d by requesting e.g.
  1/200 s and measuring the delivered timestamp deltas.
- Raw accelerometer values are reported in **g** **[doc]**; `CMDeviceMotion` additionally separates
  `gravity` from `userAcceleration` and exposes attitude/rotation rate **[doc]**
  (https://developer.apple.com/documentation/coremotion/cmdevicemotion). The prototype does its own
  gravity split (`imukit.preprocess.gravity_split`), so **raw accelerometer is preferred** — device
  motion applies undocumented fusion/filtering that could attenuate the 20–90 Hz band we care about
  **[inference]** **[validate]**.
- `CMLogItem.timestamp` is **seconds since device boot** **[doc]**
  (https://developer.apple.com/documentation/coremotion/cmlogitem/timestamp) — monotonic, and must
  be converted to wall clock once per session (boot-time offset) for cross-device sync.
- `CMSensorRecorder` can record accelerometer data for later retrieval, subject to availability
  **[doc]** (https://developer.apple.com/documentation/coremotion/cmsensorrecorder). It is a
  low-rate, OS-managed historical record, not a substitute for a live high-rate capture
  **[inference]**; not recommended for this project.

**Background behaviour.** Core Motion updates are not, by themselves, a background mode. The
practical, documented route to keep a session alive with the screen off is a Core Location
background session: add `location` to `UIBackgroundModes` and set
`allowsBackgroundLocationUpdates = true` **[doc]**
(https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes,
https://developer.apple.com/documentation/corelocation/cllocationmanager/allowsbackgroundlocationupdates).
Also set `pausesLocationUpdatesAutomatically = false`, since automatic pausing saves battery but
would truncate a continuous record **[doc]**
(https://developer.apple.com/documentation/corelocation/cllocationmanager/pauseslocationupdatesautomatically).
Whether IMU delivery genuinely continues uninterrupted for the whole run under that arrangement is
**[validate]** — this is the single most important hardware test before a field campaign.

**Core Location precision.** `desiredAccuracy` is a *request*, not a guarantee, and is overridden
when the user has granted only reduced accuracy; higher accuracy costs time and battery **[doc]**
(https://developer.apple.com/documentation/corelocation/cllocationmanager/desiredaccuracy). Each
`CLLocation` carries its own `timestamp` **[doc]**
(https://developer.apple.com/documentation/corelocation/cllocation/timestamp) — use it, never the
arrival time.

### 1.2 React Native — `react-native-sensors`

- Exposes sensors as an RxJS `Observable`; rate is set with
  `setUpdateIntervalForType(SensorTypes.accelerometer, ms)` and the documented **default interval is
  100 ms (10 Hz)** **[doc]** (https://react-native-sensors.github.io/docs/Usage.html,
  https://github.com/react-native-sensors/react-native-sensors).
- Samples are forwarded individually into JS. At 200 Hz that is 200 cross-boundary events/second
  competing with UI work on the JS thread; back-pressure appears as **dropped or coalesced samples
  with no per-sample capture timestamp guarantee** **[inference]**. The library does not document
  batching, drop counters, or lossless delivery **[doc: absent]**.
- React Native's New Architecture (JSI) removes the old asynchronous, serialising bridge and lowers
  native↔JS call overhead **[doc]** (https://reactnative.dev/architecture/landing-page) — but lower
  overhead is *not* a delivery guarantee, and JS remains a single event loop **[inference]**.

**Verdict:** acceptable for a live 10–50 Hz preview; **not** acceptable as the recorder of record.

### 1.3 Expo Sensors

- `expo-sensors` supports iOS, Android and web; interval is requested with
  `Accelerometer.setUpdateInterval(ms)` (the docs' own "fast" example uses **16 ms ≈ 60 Hz**), and
  each measurement carries `timestamp, x, y, z` **[doc]**
  (https://docs.expo.dev/versions/latest/sdk/accelerometer/).
- Expo documents an **Android 12+ system limit of 200 Hz per sensor** for apps **[doc]** (same page)
  — relevant if Android is ever a target.
- On web, sensor access requires permission and a secure context, and availability detection is
  documented as unreliable **[doc]** (same page).

**Verdict:** same structural limitation as `react-native-sensors` — samples cross into JS one at a
time. Fine for the UI/UX shell and for GPS, not for the 200 Hz record **[inference]**.

### 1.4 CoreMotion native module behind React Native

This is the recommended shape if the app is RN (see §1.6). Capture, timestamping and buffering stay
in Swift; JS only controls the session and receives *summaries*.

### 1.5 Web / PWA

- `DeviceMotionEvent` is available **only in secure contexts**, may require an explicit permission
  request (iOS Safari), and exposes `acceleration`, `accelerationIncludingGravity`, `rotationRate`
  and an `interval` field that reports the **underlying hardware event granularity** **[doc]**
  (https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent,
  https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/interval).
- There is no documented way to *raise* the rate, no batching, no drop accounting, and background
  tabs / locked screens are throttled or suspended by the browser **[inference]**.

**Verdict:** unusable as the primary recorder. Useful only as a zero-install demo/triage tool.

### 1.6 When native capture is mandatory, and the module architecture

Native capture is required as soon as any of these hold — all of which hold here: sustained ≥ 100 Hz;
per-sample hardware timestamps; verifiable no-drop delivery; capture continuing while backgrounded.

Practical architecture if RN is kept:

```
JS (RN)                     Native (Swift)
────────                    ──────────────────────────────────────────────
start(config)  ──────────▶   CMMotionManager (single instance)
                             accelerometerUpdateInterval = 1/200
                             handler on a dedicated OperationQueue
                               └─ append {t_boot, ax, ay, az} to a ring buffer
                             CLLocationManager (bg mode + allowsBackground…)
                               └─ append {t_wall, lat, lon, hAcc, vAcc, speed}
                             writer task → append-only binary/NDJSON chunk file
◀────── event (1 Hz) ──────   {n_samples, actual_fs, dropped, queue_depth, last_t}
stop()        ──────────▶     flush, close file, return file URL + manifest
```

Rules: nothing per-sample crosses into JS; the file is written by the native side; JS gets a 1 Hz
health event (measured effective rate + drop counter) and, at the end, a file URL to upload/share.
Session manifest records device model, OS version, requested vs **measured** rate, boot-time offset,
carry position and app version.

### 1.7 Comparison

| Stack | Realistic accel rate | Per-sample HW timestamps | Batching / drop accounting | Background capture | Effort | Fit |
|---|---|---|---|---|---|---|
| Native Swift + Core Motion | 100 Hz documented floor, 200 Hz likely **[validate]** | Yes (`CMLogItem.timestamp`, boot-relative) | You implement it | Yes, via Core Location background mode **[validate]** | Medium | **Recorder of record** |
| RN + native CoreMotion module | Same as native | Yes | You implement it | Same as native | Medium | **Recommended if app is RN** |
| `react-native-sensors` | 10 Hz default; higher requested, delivery unverified | Not guaranteed | None documented | No | Low | Live preview only |
| `expo-sensors` | ~60 Hz per docs' own example | Provided but JS-delivered | None documented | No | Lowest | UI shell, GPS, preview |
| Web / PWA (`DeviceMotionEvent`) | Hardware-dictated, unsettable | `interval` only | None | No | Lowest | Demo/triage only |

---

## 2. Wearables — Garmin

### 2.1 Connect IQ: what the API documents

- `Toybox.Sensor.registerSensorDataListener` takes an options dictionary covering accelerometer,
  gyroscope, magnetometer and heartbeat data, a **period**, a **sample rate**, whether to include
  timestamps, and synchronous mode **[doc]**
  (https://developer.garmin.com/connect-iq/api-docs/Toybox/Sensor.html).
- The callback is **batch-oriented**: it fires when a configured *period* of data is available, and
  `SensorData` encapsulates arrays of high-frequency accelerometer/gyroscope samples **[doc]**
  (https://developer.garmin.com/connect-iq/api-docs/Toybox/Sensor/SensorData.html).
- `AccelerometerData` x/y/z values are in **milli-g**, with timestamps as an array in
  **milliseconds** when requested; the API also exposes max-sample-rate queries **[doc]**
  (https://developer.garmin.com/connect-iq/api-docs/Toybox/Sensor/AccelerometerData.html).
- `SensorLogging.SensorLogger` can be handed to an activity-recording session so sensor data is
  logged into the recorded activity **[doc]**
  (https://developer.garmin.com/connect-iq/api-docs/Toybox/SensorLogging.html,
  https://developer.garmin.com/connect-iq/api-docs/Toybox/SensorLogging/SensorLogger.html).
- `ActivityRecording` creates/saves/discards FIT sessions **[doc]**
  (https://developer.garmin.com/connect-iq/api-docs/Toybox/ActivityRecording.html,
  https://developer.garmin.com/connect-iq/core-topics/activity-recording/); FIT itself is documented
  at https://developer.garmin.com/fit/protocol/. GPS comes from `Toybox.Position` **[doc]**
  (https://developer.garmin.com/connect-iq/api-docs/Toybox/Position.html).
- Backgrounding on CIQ is a constrained, OS-scheduled model **[doc]**
  (https://developer.garmin.com/connect-iq/core-topics/backgrounding/); sensor availability can
  change across active/inactive transitions **[doc]**.

**Explicitly not established by the official docs** (do not claim these):

- A universal maximum accelerometer sample rate. Community/API discussion commonly reports **25 Hz
  max and a 4 s max period** on many watches **[inference, community-sourced]** — the official docs
  provide *methods to query* the maximum rather than a single number, so treat the per-watch limit as
  **[validate]**.
- That arbitrary raw accelerometer samples appear in consumer FIT exports, or are retrievable through
  Garmin Connect / mobile APIs. Getting a raw stream *off* the watch and into analysis is the least
  documented link in the chain **[validate]**.

**Bandwidth verdict:** if 25 Hz is the real ceiling, the watch cannot see the 20–45 Hz shock band at
all (Nyquist 12.5 Hz), and cannot support `hf_frac`. It *can* support cadence and low-frequency
structural modes (< ~10 Hz). So the watch is a **secondary/context sensor**, not a replacement for
the phone IMU.

### 2.2 HRM-Pro / HRM-Run running dynamics

- The HRM-Pro contains an accelerometer that measures torso movement and computes six running
  metrics; running dynamics require pairing to a compatible Garmin device over **ANT+** **[doc]**
  (https://www8.garmin.com/manuals/webhelp/GUID-8918512F-8099-433F-86CC-3E8249295E07/EN-US/GUID-62A09512-518A-424A-8491-FE2B80CD2091.html).
- Documented granularity: ground contact time in **ms per step**, vertical oscillation in **cm** of
  torso bounce, plus cadence, stride length, GCT balance, vertical ratio **[doc]**. Ground contact
  time and balance are **not available while walking** **[doc]** — a hard constraint for a
  walking-pace survey protocol.
- These are **processed per-step metrics, not a raw accelerometer stream**. No official API exposes
  HRM-Pro raw acceleration **[doc: absent]**; availability live (via a CIQ app reading ANT+ fields)
  vs only in FIT/Connect, and the exported granularity, are **[validate]**.

### 2.3 Usefulness vs phone IMU, and confounders

Useful because per-step GCT/vertical-oscillation/stride-length give an independent, low-rate measure
of *gait state*, which is the dominant confounder for our features: a change in cadence, speed or
fatigue changes footstep shock even on an unchanged surface. Using them as covariates (or to reject
windows where gait shifted) is the strongest argument for the wearables **[inference]**.

Not useful for the target band: torso-mounted, processed, low-rate, walking-restricted.

Synchronisation and calibration concerns:

- Three clocks (iPhone boot-relative Core Motion, iPhone wall clock via Core Location, watch/FIT
  timestamps). Align via GPS wall-clock time on both devices plus a deliberate **sync gesture**
  (3 hard heel-stamps at the start and end of every pass) visible in every stream **[inference]**.
- Residual offsets of tens of ms are fine for gait covariates but not for cross-sensor waveform
  comparison — don't attempt the latter.
- Calibration: record a known-good baseline segment per session/device/carry-position; features are
  scored against a robust per-session baseline (`imukit.robust`), which absorbs scale differences but
  not spectral filtering differences.

---

## 3. Hackathon architecture (iPhone + Garmin watch + HRM)

### 3.1 MVP capture path (implement now)

1. **Recorder of record:** small native Swift app (or RN + the §1.6 native module). Raw
   accelerometer at requested 200 Hz (fall back to 100 Hz if the delivered rate is lower) + gyro at
   the same rate + Core Location best-accuracy 1 Hz, background mode enabled.
2. **Sensor placement:** phone in a **snug front pocket or waist belt**, one fixed orientation per
   session; carry position recorded in the manifest. E5 (synthetic) ranked a
   torso/backpack-style mount above pocket and hand carry. Never hand-held-while-filming.
3. **Protocol:** walk the same 100–200 m route **≥ 4 passes**, alternating direction, with the
   heel-stamp sync gesture at both ends. Note ground-truth anomaly locations by hand (photo + rough
   distance) — this is the label set.
4. **Watch/HRM (best effort):** standard Garmin activity for GCT/cadence/vertical oscillation +
   FIT export; a CIQ `SensorLogger` accelerometer experiment only if time allows.
5. **Export:** native side writes an append-only chunk file, then shares/uploads it; analysis runs
   offline with the existing `apps/bridge` pipeline.

### 3.2 Data schema

```jsonc
// manifest.json
{ "session_id": "...", "device": "iPhone15,2", "os": "18.x", "app": "bridge-rec 0.1",
  "requested_fs": 200, "measured_fs": 198.7, "dropped": 0,
  "boot_time_utc": "2026-08-29T09:12:03.412Z",
  "carry_position": "front_pocket", "route": "footbridge-A", "pass_index": 3,
  "sync_marks_s": [4.21, 187.55] }
// imu.ndjson  (one record per sample; t = seconds since boot)
{ "t": 12.345000, "ax": 0.0123, "ay": -0.9871, "az": 0.0456, "gx": ..., "gy": ..., "gz": ... }
// gps.ndjson
{ "t_utc": "...", "t_boot": 12.30, "lat": 51.5, "lon": -0.1, "h_acc_m": 4.2, "speed_mps": 1.4 }
```

This maps 1:1 onto `imukit.types.ImuTrace` / `GpsTrack`, so an importer is a thin adapter.

### 3.3 Sampling / processing strategy

Capture at the highest verified rate; the pipeline resamples to 200 Hz internally, high-passes above
4 Hz after stride-template subtraction, and needs GPS accuracy per fix to drop bad windows. Prefer
multi-pass aggregation (E3: F1 1.0 from two passes vs 0.75 from one).

### 3.4 Defer

Real-time on-device detection; Android; CIQ raw-accelerometer streaming; HRM raw access; any
absolute modal-frequency claim; cloud infrastructure.

### 3.5 Fallback if Garmin is blocked

Phone-only, unchanged: the watch/HRM contribute covariates, not the primary signal. Secondary
fallback for gait state is the phone's own cadence estimate (`imukit.cadence`), which the pipeline
already computes.

### 3.6 Decision matrix

| Decision | Choose | Why | Fallback |
|---|---|---|---|
| Recorder | Native Swift Core Motion (own module if RN) | Only stack with documented per-sample timestamps and controllable rate | RN/Expo at ~50 Hz (degrades detection; E5 F1 0.5) |
| Rate | Request 200 Hz, accept ≥ 100 Hz | Shock band 20–45 Hz + `hf_frac` | 100 Hz (50 Hz halves F1) |
| Accel source | Raw accelerometer, own gravity split | Avoid undocumented fusion filtering | `CMDeviceMotion` userAcceleration |
| Background | Core Location bg mode, auto-pause off | Documented route to survive screen lock | Screen-on, phone in pocket, low brightness |
| Watch role | Gait covariates from standard activity FIT | Documented metrics, low integration risk | Phone-derived cadence |
| Analysis | Offline, existing `apps/bridge` | Fastest path to results | — |

### 3.7 Risks / open questions

1. Delivered accelerometer rate and jitter on the target iPhone — **[validate]** first.
2. Whether IMU delivery truly survives backgrounding for a full run — **[validate]**.
3. Undocumented OS-side filtering of the raw accelerometer above ~50 Hz — **[validate]** with a
   shaker or a controlled tap test.
4. Per-watch CIQ accelerometer max rate/period, and whether raw samples can be exported at all.
5. Whether HRM running dynamics are usable at walking pace (GCT/balance documented as unavailable).
6. Real-world SNR: everything in `FEASIBILITY.md` is synthetic; no field data exists yet.
7. Battery/thermal cost of 200 Hz IMU + best-accuracy GPS over a long session.

---

## 4. Bottom line

Use a native Core Motion recorder writing its own file, with a measured effective rate in the
manifest; treat React Native/Expo as the UI and the web as a demo toy; treat the Garmin watch and
HRM-Pro as **gait-context sensors** whose published capabilities (25 Hz-class accelerometer, processed
per-step running dynamics, no documented raw HRM stream) cannot cover the 20–90 Hz band the detector
relies on. Every rate/background/export assumption above marked **[validate]** should be measured on
the actual devices before any field campaign is planned around it.
