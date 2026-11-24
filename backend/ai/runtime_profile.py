"""Hardware-aware runtime profiles and dynamic feature gating helpers."""
import os
import psutil


PROFILES = {
    'lite': {
        'name': 'lite',
        'personModel': 'yolo11n.onnx',
        'objectModel': 'yolo11n.onnx',
        'faceModel': 'scrfd_2.5g.onnx',
        'maxDetectEdge': 1280,
        'maxTrackEdge': 480,
        'faceBatchLimit': 8,
        'faceWorkers': 2,
        'peopleIntervalMs': 0,
        'poseIntervalMs': 600,
        'restIntervalMs': 600,
        'sceneIntervalMs': 700,
        'sceneTileCrop': False,
        'pixelHistory': 45,
        'personHistory': 16,
        'objectHistory': 16,
        'faceHistory': 6,
        'faceMaxEdge': 640,
        'personTrackEdge': 400,
        'objectTrackEdge': 480,
        'maxObjects': 12,
        'shareYoloSession': True,
        'lazyOptionalModels': True,
        'skipLowLightRetryWhenNormal': True,
    },
    'balanced': {
        'name': 'balanced',
        'personModel': 'yolo11n.onnx',
        'objectModel': 'yolo11n.onnx',
        'faceModel': 'scrfd_2.5g.onnx',
        'maxDetectEdge': 1280,
        'maxTrackEdge': 480,
        'faceBatchLimit': 8,
        'faceWorkers': 3,
        'peopleIntervalMs': 0,
        'poseIntervalMs': 350,
        'restIntervalMs': 350,
        'sceneIntervalMs': 700,
        'sceneTileCrop': True,
        'pixelHistory': 60,
        'personHistory': 16,
        'objectHistory': 24,
        'faceHistory': 6,
        'faceMaxEdge': 800,
        'personTrackEdge': 400,
        'objectTrackEdge': 480,
        'maxObjects': 16,
        'shareYoloSession': True,
        'lazyOptionalModels': True,
        'skipLowLightRetryWhenNormal': True,
    },
}


def resolve_profile(mode=None, total_mb=None):
    """Select lite (8 GB priority) or balanced (16 GB+) profile."""
    requested = (mode or os.environ.get('AI_PROFILE') or 'auto').strip().lower()
    if requested in PROFILES:
        return dict(PROFILES[requested])
    if requested == 'full':
        full = dict(PROFILES['balanced'])
        full.update(name='full', personModel='yolo11s.onnx', faceModel='scrfd_10g.onnx',
                    pixelHistory=120, lazyOptionalModels=False)
        return full
    if total_mb is None:
        total_mb = psutil.virtual_memory().total / (1024 ** 2)
    return dict(PROFILES['lite' if total_mb <= 10752 else 'balanced'])


def default_features():
    """RAM-light classroom-priority defaults: core 7 signs on, objects off."""
    return {
        'objects': False,
        'hands': False,
        'faceMesh': True,
        'profileMesh': True,
        'pose': True,
        'deskRest': True,
        'faceHeading': True,
    }


def merge_features(session_configs):
    """Union active pipeline requirements across live sessions."""
    if not session_configs:
        return default_features()
    keys = ('objects', 'hands', 'faceMesh', 'profileMesh', 'pose', 'deskRest', 'faceHeading')
    return {key: any(bool(config.get(key, False)) for config in session_configs) for key in keys}
