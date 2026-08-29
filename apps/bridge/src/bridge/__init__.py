"""bridge - "feet as a sensor network" feasibility prototype."""

from .detect import detect_multi_pass, detect_single_pass, modal_signature, score_pass
from .evaluate import evaluate_detections, roc_auc
from .pipeline import process_pass, suppress_cadence
from .synth import Anomaly, SurfaceScenario, simulate_pass

__all__ = [
    "Anomaly",
    "SurfaceScenario",
    "detect_multi_pass",
    "detect_single_pass",
    "evaluate_detections",
    "modal_signature",
    "process_pass",
    "roc_auc",
    "score_pass",
    "simulate_pass",
    "suppress_cadence",
]
