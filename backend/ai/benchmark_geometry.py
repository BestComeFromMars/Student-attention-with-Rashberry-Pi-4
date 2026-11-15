"""A reproducible pixel-size/load test, not a claim about meters or real classroom accuracy."""
import argparse
import json
import math
import time
from pathlib import Path
import cv2
import numpy as np
from geometry import FaceGeometry


def build_sheet(root, count, face_width):
    image = cv2.imread(str(root/"test-fixtures/portrait.jpg"))
    geometry = FaceGeometry(root/"models/classroom/scrfd_2.5g.onnx")
    try:
        face = geometry.update(image,int(time.time()*1000))[0]
    finally:
        geometry.close()
    h,w = image.shape[:2]
    x,y,bw,bh = face["box"]
    crop = image[max(0,int((y-.1*bh)*h)):min(h,int((y+1.1*bh)*h)),
                 max(0,int((x-.1*bw)*w)):min(w,int((x+1.1*bw)*w))]
    tile = cv2.resize(crop,(face_width+12,int((face_width+12)*crop.shape[0]/crop.shape[1])))
    sheet = np.full((1080,1920,3),235,np.uint8)
    cols = min(8,math.ceil(math.sqrt(count*1920/1080)))
    rows = math.ceil(count/cols)
    for index in range(count):
        left = int((index%cols+.5)*1920/cols-tile.shape[1]/2)
        top = int((index//cols+.5)*1080/rows-tile.shape[0]/2)
        sheet[top:top+tile.shape[0],left:left+tile.shape[1]] = tile
    return sheet


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames",type=int,default=30)
    parser.add_argument("--output",type=Path)
    parser.add_argument("--fixtures",type=Path)
    args = parser.parse_args()
    cv2.setNumThreads(1)
    root = Path(__file__).resolve().parent.parent
    results = []
    for count in [10,20,40]:
        for width in [32,64]:
            sheet = build_sheet(root,count,width)
            if args.fixtures:
                args.fixtures.mkdir(parents=True,exist_ok=True)
                cv2.imwrite(str(args.fixtures/f'classroom-{count}-{width}.jpg'),sheet,[cv2.IMWRITE_JPEG_QUALITY,90])
            geometry = FaceGeometry(root/"models/classroom/scrfd_2.5g.onnx")
            durations,counts = [],[]
            base = int(time.time()*1000)
            try:
                for index in range(args.frames):
                    matrix = np.float32([[1,0,math.sin(index/5)*3],[0,1,0]])
                    frame = cv2.warpAffine(sheet,matrix,(1920,1080),borderValue=(235,235,235))
                    started = time.perf_counter()
                    faces = geometry.update(frame,base+index*34)
                    durations.append((time.perf_counter()-started)*1000)
                    counts.append(len(faces))
            finally:
                geometry.close()
            result = dict(expectedFaces=count,targetFacePixels=width,detectedFaces=counts[-1],
                meanMs=round(float(np.mean(durations)),2),p95Ms=round(float(np.percentile(durations,95)),2),
                processingFps=round(1000/float(np.mean(durations)),2),
                startupMs=round(durations[0],2),
                steadyFps=round(1000/float(np.mean(durations[1:])),2))
            results.append(result)
            print(json.dumps(result),flush=True)
    report = dict(test="synthetic portrait grid; geometry only; no physical-distance or behavior-accuracy claim",results=results)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(report,indent=2),encoding="utf8")


if __name__ == "__main__":
    main()
