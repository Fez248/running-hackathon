"""bridge - "feet as a sensor network" feasibility prototype."""

from .detect import detect_multi_pass, detect_single_pass, modal_signature, score_pass
from .evaluate import evaluate_detections, roc_auc
from .ingest import Recording, load_recording
from .pipeline import process_pass, suppress_cadence
from .quality import CaptureQuality, assess
from .scan import Finding, ScanResult, scan_recording, to_geojson
from .synth import Anomaly, SurfaceScenario, simulate_pass

__all__ = [
    "Anomaly",
    "CaptureQuality",
    "Finding",
    "Recording",
    "ScanResult",
    "SurfaceScenario",
    "assess",
    "detect_multi_pass",
    "detect_single_pass",
    "evaluate_detections",
    "load_recording",
    "modal_signature",
    "process_pass",
    "roc_auc",
    "scan_recording",
    "score_pass",
    "simulate_pass",
    "suppress_cadence",
    "to_geojson",
]
