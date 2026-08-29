"""Scoring detections against synthetic ground truth."""

from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np

from .detect import Detection
from .synth import Anomaly


@dataclass
class EvalResult:
    tp: int
    fp: int
    fn: int
    precision: float
    recall: float
    f1: float
    mean_localization_error_m: float | None
    roc_auc: float | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _overlaps(det: Detection, gt: Anomaly, tol_m: float) -> bool:
    return det.end_m >= gt.start_m - tol_m and det.start_m <= gt.end_m + tol_m


def evaluate_detections(
    detections: list[Detection],
    truth: list[Anomaly],
    tol_m: float = 10.0,
) -> EvalResult:
    """Event-level precision/recall with a distance tolerance.

    Tolerance defaults to 10 m: consumer GPS gives ~3-8 m of along-path error, so
    tighter scoring would measure GPS quality rather than detection quality.
    """
    matched_gt: set[int] = set()
    errors: list[float] = []
    tp = 0
    for det in detections:
        # Match the *nearest* unmatched overlapping anomaly, so scoring does not
        # depend on the order of the input lists when tolerances make two
        # anomalies eligible for the same detection.
        candidates = [
            (abs(det.peak_m - 0.5 * (gt.start_m + gt.end_m)), i)
            for i, gt in enumerate(truth)
            if i not in matched_gt and _overlaps(det, gt, tol_m)
        ]
        if not candidates:
            continue
        hit = min(candidates)[1]
        matched_gt.add(hit)
        tp += 1
        center = 0.5 * (truth[hit].start_m + truth[hit].end_m)
        errors.append(abs(det.peak_m - center))
    fp = len(detections) - tp
    fn = len(truth) - len(matched_gt)
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return EvalResult(
        tp=tp,
        fp=fp,
        fn=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        mean_localization_error_m=float(np.mean(errors)) if errors else None,
    )


def window_labels(distance_m: np.ndarray, truth: list[Anomaly], tol_m: float = 0.0) -> np.ndarray:
    lab = np.zeros(np.size(distance_m), dtype=bool)
    for gt in truth:
        lab |= (distance_m >= gt.start_m - tol_m) & (distance_m <= gt.end_m + tol_m)
    return lab


def roc_auc(scores: np.ndarray, labels: np.ndarray) -> float | None:
    """Mann-Whitney U based AUC (no sklearn dependency)."""
    scores = np.asarray(scores, dtype=float)
    labels = np.asarray(labels, dtype=bool)
    pos, neg = scores[labels], scores[~labels]
    if pos.size == 0 or neg.size == 0:
        return None
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(order.size, dtype=float)
    ranks[order] = np.arange(1, order.size + 1)
    # average ranks for ties
    allv = np.concatenate([pos, neg])
    for v in np.unique(allv):
        m = allv == v
        if m.sum() > 1:
            ranks[m] = ranks[m].mean()
    r_pos = ranks[: pos.size].sum()
    return float((r_pos - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size))
