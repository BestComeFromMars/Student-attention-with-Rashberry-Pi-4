"""Mouth aperture in the landmarker coordinate system, retaining depth under head turns."""
import numpy as np


def measure_mouth(landmarks, crop_width, crop_height):
    selected = [landmarks[index] for index in [13, 14, 61, 291]]
    xy = np.asarray([[point.x*crop_width, point.y*crop_height] for point in selected], np.float64)
    missing = dict(mouthOpenRatio=None, mouthOpenRatio2d=None)
    if not np.isfinite(xy).all():
        return missing
    width_2d = float(np.linalg.norm(xy[2]-xy[3]))
    projected = float(np.linalg.norm(xy[0]-xy[1])/width_2d) if width_2d >= 1 else None
    z = np.asarray([getattr(point, 'z', float('nan')) for point in selected], np.float64)
    if not np.isfinite(z).all():
        return dict(mouthOpenRatio=projected, mouthOpenRatio2d=projected)
    # MediaPipe z has the same scale as x (image width), including in a
    # non-square crop. This is relative depth, not a metric distance estimate.
    xyz = np.column_stack((xy, z*crop_width))
    width_3d = float(np.linalg.norm(xyz[2]-xyz[3]))
    aperture = float(np.linalg.norm(xyz[0]-xyz[1])/width_3d) if width_3d >= 1 else None
    return dict(mouthOpenRatio=aperture, mouthOpenRatio2d=projected)
