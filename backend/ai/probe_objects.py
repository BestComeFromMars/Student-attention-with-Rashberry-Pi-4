"""Inspect the real pinned YOLO11m detector on image files; no camera access."""
import argparse
import json
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('YOLO_CONFIG_DIR', str(ROOT / '.tmp' / 'ultralytics'))
os.environ.setdefault('OMP_NUM_THREADS', '1')
os.environ.setdefault('MKL_NUM_THREADS', '1')
os.environ.setdefault('OPENBLAS_NUM_THREADS', '1')

import cv2
from onnx_yolo import ONNXRuntimeYOLO


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, help='Optional directory for real detector rectangles and JSON')
    args = parser.parse_args()
    model = ONNXRuntimeYOLO(ROOT / 'models/classroom/yolo11m.onnx')
    names = {63: 'laptop', 67: 'phone', 73: 'book'}
    results = []
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
    for path in args.images:
        frame = cv2.imread(str(path))
        if frame is None:
            raise ValueError('Cannot read image: ' + str(path))
        started = time.perf_counter()
        boxes = model.predict(frame, classes=list(names), conf=.25)[0].boxes.data.cpu().numpy()
        detections = [dict(kind=names[int(row[5])], confidence=float(row[4]),
            xyxy=[float(value) for value in row[:4]]) for row in boxes]
        result = dict(image=str(path), model='yolo11m.onnx', threshold=.25,
            inferenceMs=round((time.perf_counter()-started)*1000, 1), detections=detections)
        results.append(result)
        if args.output:
            for detection in detections:
                x1,y1,x2,y2 = map(round, detection['xyxy'])
                cv2.rectangle(frame, (x1,y1), (x2,y2), (0,200,255), 2)
                cv2.putText(frame, f"{detection['kind']} {detection['confidence']:.2f}",
                    (max(0,x1),max(18,y1-5)), cv2.FONT_HERSHEY_SIMPLEX, .6, (0,200,255), 2)
            cv2.imwrite(str(args.output / (path.stem + '-detected.jpg')), frame)
    output = json.dumps(results, indent=2)
    if args.output:
        (args.output / 'detections.json').write_text(output + '\n', encoding='utf-8')
    print(output)


if __name__ == '__main__':
    main()
