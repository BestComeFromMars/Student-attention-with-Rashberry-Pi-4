"""Export the pinned original YOLO11 weights for the local OpenCV CPU runtime."""
import sys
from pathlib import Path
import torch
from ultralytics import YOLO

torch.set_num_threads(1)
root=Path(sys.argv[1])
for name in ['yolo11s','yolo11m','yolo11n-pose']:
    target=root/(name+'.onnx')
    if target.exists():
        continue
    YOLO(str(root/(name+'.pt'))).export(format='onnx',imgsz=640,batch=1,device='cpu',
        opset=12,dynamic=False,simplify=False,nms=False)
