"""The failure path must print its verdict, and say what to fix, on every platform."""

import io
import json

import numpy as np
import pytest
from imukit.types import GpsTrack, ImuTrace

from bridge.console import ascii_fallback, echo, safe_text
from bridge.doctor import MAX_SENSORS_FOR_FAST_RATE, diagnose, format_diagnosis
from bridge.ingest import Provenance, Recording

CP1252 = "cp1252"


def cp1252_stream() -> io.TextIOWrapper:
    """A stdout that behaves like a Windows console."""
    return io.TextIOWrapper(io.BytesIO(), encoding=CP1252, errors="strict", newline="")


def make_recording(
    fs: float = 100.0,
    duration_s: float = 120.0,
    gravity: bool = True,
    accuracy_m: float = 4.4,
    sensors: tuple[str, ...] = ("Accelerometer", "Location"),
    requested_fs_hz: float | None = 200.0,
    unit_scale: float = 1.0,
) -> Recording:
    t = np.arange(0.0, duration_s, 1.0 / fs)
    vert = 2.0 * np.sin(2 * np.pi * 2.8 * t)
    z = (9.80665 if gravity else 0.0) + vert
    accel = np.column_stack([np.zeros_like(t), np.zeros_like(t), z])
    gt = np.arange(0.0, duration_s, 1.0)
    gps = GpsTrack(
        t=gt,
        lat=51.5386 + gt * 3.0 / 111_320.0,
        lon=np.full(gt.size, -0.0166),
        accuracy_m=np.full(gt.size, accuracy_m),
    )
    return Recording(
        trace=ImuTrace(t=t, accel=accel, fs=fs),
        gps=gps,
        source="test",
        format="sensorlogger",
        provenance=Provenance(
            recorder_app="Sensor Logger",
            device_model="iPhone 12 Pro Max",
            requested_fs_hz=requested_fs_hz,
            measured_fs_hz=fs,
            unit_scale=unit_scale,
            sensors=list(sensors),
        ),
    )


def test_ascii_fallback_keeps_the_comparison_it_transliterates():
    assert ascii_fallback("\u2265100 Hz, \u22643 m") == ">=100 Hz, <=3 m"
    assert ascii_fallback("route \u2014 200 m \u00b15 m") == "route -- 200 m +/-5 m"


def test_echo_prints_the_verdict_under_cp1252_instead_of_crashing():
    stream = cp1252_stream()
    echo("sampled below \u2265100 Hz \u2014 unusable", stream=stream)
    stream.flush()
    written = stream.buffer.getvalue().decode(CP1252)
    assert written == "sampled below >=100 Hz -- unusable\n"


def test_echo_leaves_the_text_alone_where_the_terminal_can_show_it():
    stream = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", newline="")
    echo("\u2265100 Hz", stream=stream)
    stream.flush()
    assert stream.buffer.getvalue().decode("utf-8") == "\u2265100 Hz\n"


def test_safe_text_survives_an_unknown_encoding():
    class Odd:
        encoding = "not-an-encoding"

    assert safe_text("\u2265100 Hz", Odd()) == ">=100 Hz"


def test_format_report_of_a_rejected_capture_prints_on_a_windows_console():
    """The whole point of 1.3: a rejected capture prints its verdict, not a traceback."""
    from bridge.scan import format_report, scan_recording

    rec = make_recording(fs=30.0, gravity=False, duration_s=40.0)
    result, _ = scan_recording(rec)
    assert not result.quality.usable
    stream = cp1252_stream()
    echo(format_report(result), stream=stream)
    stream.flush()
    text = stream.buffer.getvalue().decode(CP1252)
    assert "UNUSABLE" in text
    assert result.quality.problems


def test_doctor_reports_the_rate_the_phone_actually_delivered():
    d = diagnose(make_recording(fs=99.95, requested_fs_hz=200.0))
    assert d.measured_fs_hz == pytest.approx(99.95, rel=0.01)
    assert d.requested_fs_hz == 200.0
    assert any("delivered" in a for a in d.advice)


def test_doctor_names_the_sensors_to_turn_off():
    nine = (
        "Accelerometer",
        "AccelerometerUncalibrated",
        "Gyroscope",
        "Magnetometer",
        "Barometer",
        "Location",
        "Pedometer",
        "Microphone",
        "Compass",
    )
    d = diagnose(make_recording(fs=99.95, sensors=nine))
    assert d.n_sensors > MAX_SENSORS_FOR_FAST_RATE
    advice = " ".join(d.advice)
    assert "Accelerometer and Location only" in advice
    assert "Gyroscope" in advice
    assert "99.95 Hz" in advice


def test_doctor_reports_the_gps_accuracy_distribution():
    rec = make_recording(accuracy_m=16.9)
    d = diagnose(rec)
    assert d.gps_accuracy_p50_m == pytest.approx(16.9)
    assert d.gps_frac_over_5m == pytest.approx(1.0)
    assert any("open sky" in a for a in d.advice)
    assert "16.9 m" in format_diagnosis(d)


def test_doctor_flags_a_gravity_free_stream_as_a_recorder_setting():
    d = diagnose(make_recording(gravity=False))
    assert not d.gravity_present
    assert any("Gravity" in a for a in d.advice)


def test_doctor_says_nothing_to_change_for_a_clean_capture():
    d = diagnose(make_recording(fs=200.0, requested_fs_hz=200.0, accuracy_m=2.5))
    assert d.verdict == "ok"
    assert d.advice == ["nothing to change: this capture is fit to scan as recorded."]


def test_doctor_json_is_serialisable():
    payload = json.loads(json.dumps(diagnose(make_recording()).as_dict(), default=str))
    assert payload["sensors"] == ["Accelerometer", "Location"]


def test_doctor_output_is_printable_on_a_windows_console():
    stream = cp1252_stream()
    echo(format_diagnosis(diagnose(make_recording(gravity=False))), stream=stream)
    stream.flush()
    assert "ABSENT" in stream.buffer.getvalue().decode(CP1252)
