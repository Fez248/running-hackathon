"""imukit: shared IMU/GPS signal-processing primitives.

Deliberately app-agnostic: apps under ``apps/`` compose these primitives instead
of re-implementing filtering, cadence tracking or robust baselines.
"""

from .cadence import cadence_spm, detect_footfalls, estimate_step_frequency, stride_segments
from .features import band_energy, psd, spectral_entropy, window_features
from .geo import aggregate_by_bin, bin_index, cumulative_distance, distance_at_times, haversine_m
from .modal import Mode, find_modes, frequency_shift, half_power_damping, modal_psd, notch_harmonics
from .preprocess import G, bandpass, gravity_split, highpass, lowpass, resample_uniform
from .robust import ewma_update, leave_one_out_z, mad, robust_z
from .types import GpsTrack, ImuTrace, Window

__all__ = [
    "G",
    "GpsTrack",
    "ImuTrace",
    "Mode",
    "Window",
    "aggregate_by_bin",
    "band_energy",
    "bandpass",
    "bin_index",
    "cadence_spm",
    "cumulative_distance",
    "detect_footfalls",
    "distance_at_times",
    "estimate_step_frequency",
    "ewma_update",
    "find_modes",
    "frequency_shift",
    "gravity_split",
    "half_power_damping",
    "haversine_m",
    "highpass",
    "leave_one_out_z",
    "lowpass",
    "mad",
    "modal_psd",
    "notch_harmonics",
    "psd",
    "resample_uniform",
    "robust_z",
    "spectral_entropy",
    "stride_segments",
    "window_features",
]
