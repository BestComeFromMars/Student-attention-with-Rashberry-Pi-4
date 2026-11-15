"""Audit existing SCB files and repository-local packages without downloads."""
import hashlib
from datetime import datetime, timezone
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / 'backend'
WORK = ROOT / '.qa/action-demo/scb'


def inside(path, parent=ROOT):
    return Path(path).resolve().is_relative_to(parent.resolve())


def check_file(path, expected):
    if not inside(path) or not path.is_file():
        raise RuntimeError('Missing repository-local SCB file: ' + str(path))
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise RuntimeError('SCB checksum mismatch: ' + str(path))


def main():
    if Path(sys.prefix).resolve() != (BACKEND / '.venv').resolve():
        raise RuntimeError('Run with backend/.venv through npm run verify:classroom-actions')
    packages = {}
    for distribution, module in [('pip', 'pip'), ('torch', 'torch'), ('numpy', 'numpy'),
                                 ('opencv-contrib-python', 'cv2'), ('onnx', 'onnx'),
                                 ('onnxruntime', 'onnxruntime'), ('psutil', 'psutil'), ('scipy', 'scipy')]:
        spec = importlib.util.find_spec(module)
        if spec is None or not spec.origin or not inside(spec.origin, BACKEND / '.venv'):
            raise RuntimeError('Package must be installed inside backend/.venv: ' + distribution)
        packages[distribution] = dict(version=importlib.metadata.version(distribution), path=spec.origin)
    caches = {}
    for key in ['TEMP', 'TMP', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME', 'HF_HOME', 'HF_HUB_CACHE',
                'HUGGINGFACE_HUB_CACHE', 'HF_XET_CACHE', 'TORCH_HOME', 'MPLCONFIGDIR',
                'YOLO_CONFIG_DIR', 'NUMBA_CACHE_DIR']:
        value = os.environ.get(key)
        if not value or not inside(value, BACKEND):
            raise RuntimeError('Cache/temp path must stay inside backend: ' + key)
        caches[key] = value
    if not inside(tempfile.gettempdir(), BACKEND):
        raise RuntimeError('Python temporary directory is outside backend')
    if os.environ.get('PYTHONNOUSERSITE') != '1' or os.environ.get('PIP_REQUIRE_VIRTUALENV') != 'true':
        raise RuntimeError('User-site and global pip installation must be disabled')

    spec = json.loads((BACKEND / 'ai/scb_model.json').read_text(encoding='utf-8'))
    directory = BACKEND / 'models/classroom-actions'
    checkpoint = directory / 'scb5_read_write_yolov7.pt'
    check_file(checkpoint, spec['sha256'])
    if checkpoint.stat().st_size != spec['bytes']:
        raise RuntimeError('Unexpected SCB checkpoint size')
    exported = json.loads((directory / 'scb-verification.json').read_text(encoding='utf-8'))
    if exported.get('classes') != spec['classes'] or exported.get('checkpointSha256') != spec['sha256']:
        raise RuntimeError('SCB export provenance does not match the pinned checkpoint')
    for name, key in [('scb5_read_write_yolov7.onnx', 'onnxSha256'),
                      ('scb5_read_write_yolov7.data', 'dataSha256')]:
        check_file(directory / name, exported[key])
    if not (WORK / 'equivalence-inputs.npz').is_file():
        raise RuntimeError('Missing export reference tensors; run setup:classroom-actions')
    dataset = BACKEND / 'tests/datasets/scb5_read_write'
    manifest = json.loads((dataset / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('revision') != spec['revision'] or manifest.get('classes') != spec['classes'] or len(manifest['samples']) != 32:
        raise RuntimeError('Unexpected frozen SCB validation manifest')
    for sample in manifest['samples']:
        for key in ('image', 'label'):
            check_file(dataset / sample[key], sample[key + 'Sha256'])
    report = dict(checkedAtUtc=datetime.now(timezone.utc).isoformat(),
                  installationVerified=True, repository=str(ROOT), python=sys.executable,
                  pythonBase=sys.base_prefix, pythonBaseInsideRepository=inside(sys.base_prefix),
                  packages=packages, caches=caches, classes=spec['classes'], validationImages=32,
                  checkpointSha256=spec['sha256'], defaultEnabled=False, accuracyVerified=False)
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / 'installation-check.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('SCB packages, caches/temp, checkpoint, export and 32 labeled images verified inside ' + str(ROOT), flush=True)
    print('Existing Python base: ' + sys.base_prefix + ' (no installation performed)', flush=True)


if __name__ == '__main__':
    main()
