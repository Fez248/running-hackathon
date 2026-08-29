"""Core data containers for phone-grade IMU and GPS traces."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class ImuTrace:
    """Uniformly sampled tri-axial accelerometer trace in m/s^2.

    ``accel`` is shaped (n, 3) in device frame. ``gyro`` is optional (n, 3) rad/s.
    """

    t: np.ndarray
    accel: np.ndarray
    fs: float
    gyro: np.ndarray | None = None
    meta: dict = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.t = np.asarray(self.t, dtype=float)
        self.accel = np.asarray(self.accel, dtype=float)
        if self.accel.ndim != 2 or self.accel.shape[1] != 3:
            raise ValueError(f"accel must be (n, 3), got {self.accel.shape}")
        if self.accel.shape[0] != self.t.shape[0]:
            raise ValueError("accel and t must have the same length")
        if self.gyro is not None:
            self.gyro = np.asarray(self.gyro, dtype=float)
            if self.gyro.shape != self.accel.shape:
                raise ValueError("gyro must match accel shape")

    @property
    def duration(self) -> float:
        return float(self.t[-1] - self.t[0]) if self.t.size else 0.0

    def __len__(self) -> int:
        return int(self.t.size)


@dataclass
class GpsTrack:
    """Low-rate GPS fixes (typically 1 Hz) with WGS84 coordinates."""

    t: np.ndarray
    lat: np.ndarray
    lon: np.ndarray
    accuracy_m: np.ndarray | None = None

    def __post_init__(self) -> None:
        self.t = np.asarray(self.t, dtype=float)
        self.lat = np.asarray(self.lat, dtype=float)
        self.lon = np.asarray(self.lon, dtype=float)
        if not (self.t.shape == self.lat.shape == self.lon.shape):
            raise ValueError("t, lat and lon must have the same length")
        if self.accuracy_m is not None:
            self.accuracy_m = np.asarray(self.accuracy_m, dtype=float)


@dataclass
class Window:
    """A single analysis window of a trace."""

    start: int
    stop: int
    t_center: float
    distance_m: float | None = None
