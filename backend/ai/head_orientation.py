"""Signed orientation proxy from visible head keypoints, never from a missing face."""
import numpy as np


def keypoint_heading(points):
    points = np.asarray(points)
    if points.ndim != 2 or points.shape[0] < 5 or points.shape[1] < 3:
        return None
    if not np.isfinite(points[:5, :3]).all() or points[0, 2] < .3:
        return None
    # Deep side-profile detection: when a student turns 70-110 deg sideways on a
    # front-facing classroom camera, the far ear is occluded while the near ear
    # and nose remain visible. Catch this before falling back to foreshortened eyes.
    le_eye, re_eye, le_ear, re_ear = points[1], points[2], points[3], points[4]
    sh_span = None
    if points.shape[0] >= 7 and np.isfinite(points[5:7, :3]).all() and min(points[5, 2], points[6, 2]) >= .35:
        sh_span = float(np.linalg.norm(points[5, :2] - points[6, :2]))
    if le_ear[2] >= .55 and re_ear[2] < .22:
        dx = float(points[0, 0] - le_ear[0])
        if re_eye[2] < .25 or (sh_span is not None and sh_span >= 12 and dx <= -0.28 * sh_span):
            return 0.58
    if re_ear[2] >= .55 and le_ear[2] < .22:
        dx = float(points[0, 0] - re_ear[0])
        if le_eye[2] < .25 or (sh_span is not None and sh_span >= 12 and dx >= 0.28 * sh_span):
            return -0.58
    for first, second in ((3, 4), (1, 2)):
        a, b = points[first], points[second]
        if min(a[2], b[2]) < .25:
            continue
        axis = b[:2] - a[:2]
        span2 = float(axis @ axis)
        if span2 < 25:
            continue
        offset = float((points[0, :2] - (a[:2] + b[:2]) / 2) @ axis / span2)
        return float(np.clip(offset, -1., 1.))
    return None
