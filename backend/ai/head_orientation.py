"""Signed orientation proxy from visible head keypoints, never from a missing face."""
import numpy as np


def keypoint_heading(points):
    points = np.asarray(points)
    if points.ndim != 2 or points.shape[0] < 5 or points.shape[1] < 3:
        return None
    if not np.isfinite(points[:5, :3]).all() or points[0, 2] < .3:
        return None
    for first, second in ((3, 4), (1, 2)):
        a, b = points[first], points[second]
        if min(a[2], b[2]) < .3:
            continue
        axis = b[:2] - a[:2]
        span2 = float(axis @ axis)
        if span2 < 64:
            continue
        offset = float((points[0, :2] - (a[:2] + b[:2]) / 2) @ axis / span2)
        return float(np.clip(offset, -1., 1.))
    return None
