# bridge — feasibility study

Status: **simulation-only prototype**. Every number below comes from a seeded
synthetic forward model (`bridge.synth`), not from a real phone on a real bridge.
The purpose is to answer "can this algorithm recover the effect at all, and what
does it need from the data?" before spending hardware time. See
[Limitations](#5-limitations) before quoting anything.

Reproduce: `cd apps/bridge && python -m bridge.cli run all`
(writes `docs/results/results.json`).

## 1. Physical premise

| Phenomenon | Mechanism | Signature we look for | Band |
| --- | --- | --- | --- |
| Loose paving slab | slab rocks on its bed, rattles, radiates a short impulse | *extra* broadband shock energy, higher crest/kurtosis | 20-80 Hz |
| Loose board / boardwalk | low-mass plate resonance excited per step | narrow resonance appearing/shifting per location | 8-40 Hz |
| Mat / wet patch / compliant surface | contact stiffness drops, HF content is absorbed | *loss* of HF fraction, spectral centroid falls | 20-90 Hz |
| Structural modal shift (damage proxy) | stiffness loss lowers a global mode | persistent shift of a narrow peak across all passes | 3-30 Hz |

Footstrike is a usable broadband excitation: the impact is short (~10-30 ms
contact transient), so it puts energy well above the gait band into the structure,
and the phone measures the *structure's response through the body*, not the
structure directly. That transfer path (shoe, leg, torso, hand/pocket) is the
dominant nuisance and the reason the whole design is about *relative* changes
along a route rather than absolute vibration amplitudes.

## 2. Pipeline

```
raw (t, accel[, gyro]) + GPS fixes
  1 resample_uniform      jittered device timestamps -> uniform 200 Hz grid
  2 gravity_split         0.4 Hz LP gravity estimate -> vertical / horizontal projection
                          (makes the result independent of carry orientation)
  3 estimate_step_frequency  harmonic-product spectrum, 1.0-3.6 Hz
  4 detect_footfalls      1-12 Hz band-pass + spacing-constrained peaks
  5 stride_template       phase-resample each stride to a common grid, take the median
  6 suppress_cadence      per-stride least-squares gain fit, subtract  -> residual
  7 bandpass 4-80 Hz      residual emphasised on surface/structure response
  8 features (2 s / 50% overlap windows): res_rms, res_p95, kurtosis, crest,
    spectral entropy/centroid, band energies (gait/struct/shock/hf),
    shock_struct_ratio, hf_frac, struct_frac
  9 distance_at_times     window -> along-route metres (GPS smoothed 5 s first)
```

Detection on top of that:

* **single pass** — robust (median/MAD) z-scores against the trace's *own*
  baseline, with the top decile excluded so anomalies do not inflate the
  baseline; two feature panels, `excess` (rattle) and `attenuation`
  (compliant/absorbing), each reduced by a **median over the panel** rather than a
  max, which is what killed the false-positive rate;
* **multi pass** — features aggregated into 5 m spatial bins across independent
  passes, then z-scored across bins; independent gait/carry/phone effects average
  out, location-locked effects do not;
* **modal** — Welch PSD with cadence harmonics notched and interpolated, log-PSD
  flattened by a broad median filter, narrow peaks ranked by prominence,
  candidates within 0.5 Hz of a cadence harmonic rejected, sub-bin parabolic
  interpolation, then a shift test across passes.

## 3. Experiments and results

Route: 400 m, 3 anomalies (loose slab 80-88 m, wet mat 180-205 m, loose board
300-312 m), synthetic global mode at 6.2 Hz.

### E1 — can cadence be separated from shock?
| metric | value |
| --- | --- |
| step frequency error | 0.05 Hz (2.75 vs 2.80) |
| gait-band (1-6 Hz) suppression | **-21.9 dB** |
| shock-band (20-45 Hz) retention | -0.4 dB |

The template subtraction removes ~22 dB of gait while leaving the shock band
essentially untouched. This is the load-bearing result: without it the anomaly
features are swamped.

### E2 — single-pass detection (5 passes, symmetric threshold sweep)
| z threshold | precision | recall | F1 |
| --- | --- | --- | --- |
| 2.0 | 0.53 | 1.00 | 0.69 |
| 2.5 | 0.56 | 1.00 | 0.72 |
| **3.0 (default)** | **1.00** | **0.80** | **0.88** |
| 4.0 | 1.00 | 0.67 | 0.80 |
| 5.0 | 1.00 | 0.67 | 0.80 |

Mean window-level ROC AUC 0.80, mean localization error **7.4 m** (GPS-dominated).
The recall lost at 3.0 is the wet mat, i.e. the attenuation-type anomaly is the
weak one — it is bounded (it can only remove energy) whereas a rattling slab can
add an order of magnitude.

### E3 — multi-pass spatial map
| passes | F1 |
| --- | --- |
| 1 | 0.75 |
| 2 | **1.00** |
| 3-6 | 1.00 |

Two independent passes are enough to get all three anomalies with no false
positives in this scenario. This is the recommended operating mode.

### E4 — structural modal shift
An 8% stiffness-loss shift (6.20 -> 5.70 Hz) is recovered as
**-5.7%** (estimated 6.08 -> 5.73 Hz) and alarms at a 2% threshold.
Per-pass baseline std 0.89 Hz, per-pass shift spread 3.0%. Critically, **7 of 16
passes were rejected** because a cadence harmonic sat on the mode — so modal
tracking needs *cadence diversity*, not just more passes.

### E5 — robustness (F1, multi-pass)
| knob | value | F1 |
| --- | --- | --- |
| sample rate | 50 Hz / 100 Hz / 200 Hz | 0.50 / 0.80 / 0.86 |
| carry position | hand / pocket / backpack | 0.86 / 0.86 / 1.00 |
| GPS noise | 1 m / 3 m / **8 m** | 0.86 / 0.86 / **0.00** |
| sensor noise (m/s²) | 0.06 / 0.2 / 0.5 | 0.86 / 1.00 / 0.86 |

Two hard requirements fall out of this: **≥100 Hz sampling** and **GPS error
≲3 m**. At 50 Hz the shock band is truncated; at 8 m GPS error the anomaly is
smeared across bins and localization collapses entirely even though the anomaly
is still *visible* in the residual.

### E6 — what a slow capture actually costs (precision vs recall, 10 seeds)
| sample rate | precision | recall | false positives (30 events) |
| --- | --- | --- | --- |
| 35 Hz | 0.90 | 0.30 | 0 |
| 40 Hz | 0.95 | 0.33 | 1 |
| 41 Hz | 1.00 | 0.33 | 0 |
| 45 Hz | 1.00 | 0.37 | 0 |
| 50 Hz | 1.00 | 0.33 | 0 |
| 60 Hz | 1.00 | 0.67 | 0 |
| 75 Hz | 1.00 | 0.33 | 0 |
| 90 Hz | 0.97 | 0.67 | 1 |
| 99 Hz | 0.93 | 0.70 | 2 |
| 100 Hz | 0.94 | 0.70 | 2 |
| 200 Hz | 0.91 | 0.90 | 4 |

E5's F1 collapse below 100 Hz is **entirely a recall collapse**: whatever a slow
capture does report is at least as trustworthy as at 200 Hz — precision *rises*
as the rate falls, because a detector that sees less also fires less — it just
misses defects, since each halving of the rate removes more of the 20-45 Hz
shock band. Note in particular that the false positives are not a low-rate
effect: 99 Hz and the accepted 100 Hz behave identically (0.93 vs 0.94), and the
worst precision at either end belongs to 200 Hz.

The capture gate therefore grades sample rate instead of rejecting on it —
sub-100 Hz is `degraded` and reported with a "half the defects are missed" note,
and a pass is unusable only where the physics says nothing survives: below
2 x 20 = 40 Hz the entire shock band is above Nyquist. 41 Hz is kept because it
measurably behaves like 50 Hz, not like 35 Hz. (The non-monotonicity at 60 vs
75 Hz is a one-event scenario artifact on a 3-anomaly route, as in E5.)

## 4. Assumptions

1. The baseline surface dominates the route (single-pass mode only). A route that
   is *entirely* anomalous has no baseline to z-score against.
2. Anomalies are spatially compact (metres, not hundreds of metres).
3. Cadence is quasi-stationary within a stride and drifts slowly.
4. Carry position is fixed within a pass (gain constant, absorbed by the template
   fit); it may differ between passes.
5. The synthetic mode shapes (11/27/52 Hz baseline surface modes, damped impulse
   responses, per-anomaly stiffness and damping changes) are *plausible*, not
   measured.
6. GPS gives along-path distance; the route is traversed in the same direction.

## 5. Limitations

* **No real data.** Zero phones, zero bridges. The forward model was written by
  the same author as the detector, which is the classic way to get an optimistic
  answer. Everything in §3 is a necessary, not sufficient, condition.
* The 8% modal shift in E4 is large — comparable to real structural damage
  literature only for serious damage. Small (<1%) shifts are unproven here and are
  likely below the per-pass spread (3.0%) unless many passes are averaged.
* Localization is GPS-bound (~7 m), which is coarser than a single paving slab. A
  slab-level fix needs either dense multi-pass binning, visual/manual anchoring,
  or step-integration (dead reckoning) between GPS fixes.
* Attenuation-type anomalies (mats/wet patches) are the weakest class.
* Confounders not modelled: shoes changed between passes, wind/traffic-induced
  bridge vibration, other pedestrians, temperature-driven stiffness change (a
  well-documented cause of apparent modal shifts), running speed, fatigue, phone
  case, and OS-level sensor filtering differences between phone models.
* Differences of one event in the E5 table (0.86 vs 1.00) are scenario/seed
  artifacts on a 3-anomaly route, not a ranking; only the large gaps (50 Hz,
  8 m GPS) are meaningful.

## 6. Technical feasibility plan

**Phase 0 — recording (do first).** Nothing above is testable without a capture
app that delivers ≥100 Hz IMU with trustworthy timestamps plus GPS. Constraints,
platform comparison and a recommended architecture:
[SENSOR_RECORDING_STACK.md](SENSOR_RECORDING_STACK.md).

**Phase 1 — calibration walk.** The analysis side of this phase is built:
`bridge scan` ingests a Sensor Logger / phyphox / CSV recording, gates it on the
requirements below and reports geo-located findings — see
[FLOOR_IMPERFECTION_MVP.md](FLOOR_IMPERFECTION_MVP.md). What is left is the walk:
one known route with one deliberately planted,
movable anomaly (a loose board / a doormat). 6+ passes, 2 carry positions, ground
truth marked by GPS waypoint *and* video. This is the minimum experiment that can
falsify the whole idea, and it costs one afternoon.

**Phase 2 — replace the simulator's priors.** Fit the real stride-template
residual statistics and the real surface impulse responses; re-run E2/E3/E5
against recorded data with the synthetic ground truth swapped for the marked
anomaly.

**Phase 3 — multi-pass service.** Persist per-bin feature aggregates keyed by
route bin (`ewma_update` already implements the reference update), so anomalies
are flagged as deviations from an accumulating history rather than from a single
session.

**Phase 4 — modal tracking.** Only after Phase 2. Requires cadence diversity
(§E4), temperature logging, and a long enough baseline period to separate seasonal
drift from damage.

## 7. Open questions

1. What is the actual SNR of the surface response in the phone residual? Unknown
   until Phase 1 — this single number decides whether single-pass detection is
   viable or whether everything must be multi-pass.
2. Do iOS/Android low-level sensor filters attenuate the 20-80 Hz band we depend
   on, and does it differ per device model?
3. How much of the per-pass modal spread is gait vs true structural variability?
4. Can step-integration get localization below GPS's ~7 m?
5. Do Garmin running-dynamics streams (GCT, vertical oscillation) add independent
   information about surface compliance, or are they too heavily smoothed?
   (Addressed on documentation grounds in SENSOR_RECORDING_STACK.md §2; needs
   hardware validation.)
