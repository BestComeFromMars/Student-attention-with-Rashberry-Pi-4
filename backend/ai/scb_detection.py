"""SCB YOLOv7 CPU graph with original three independent class scores."""
import hashlib,json
from pathlib import Path
import cv2
import numpy as np

CLASSES=('hand-raising','read','write')
KINDS=('raise_hand','read','take_notes')
LABELS=('Đang giơ tay','Đang đọc','Đang ghi bài')

def prepare_image(frame):
    height,width=frame.shape[:2];scale=min(640/width,640/height)
    nw,nh=round(width*scale),round(height*scale);left,top=(640-nw)//2,(640-nh)//2
    image=np.full((640,640,3),114,np.uint8)
    image[top:top+nh,left:left+nw]=cv2.resize(frame,(nw,nh),interpolation=cv2.INTER_LINEAR)
    return np.ascontiguousarray(image[:,:,::-1].transpose(2,0,1)[None],dtype=np.float32)/255.,(width,height,scale,left,top)

def decode(prediction,transform,confidence=.25,nms_iou=.45):
    width,height,scale,left,top=transform;rows=np.asarray(prediction)[0]
    if rows.ndim!=2 or rows.shape[1]!=8:raise ValueError('Wrong SCB class/output layout')
    scores=rows[:,5:]*rows[:,4:5];xywh=rows[:,:4].copy();xywh[:,:2]-=xywh[:,2:]/2
    output=[]
    # A reading score must not remove a simultaneous writing/raised-hand score.
    for label in range(3):
        candidates=np.flatnonzero(scores[:,label]>=confidence)
        if not len(candidates):continue
        indices=cv2.dnn.NMSBoxes(xywh[candidates].tolist(),scores[candidates,label].tolist(),confidence,nms_iou)
        for kept in np.asarray(indices,dtype=int).reshape(-1):
            index=candidates[kept];x,y,w,h=xywh[index]
            x1=max(0.,(x-left)/scale);y1=max(0.,(y-top)/scale)
            x2=min(float(width),(x+w-left)/scale);y2=min(float(height),(y+h-top)/scale)
            if x2>x1 and y2>y1:output.append(dict(classId=label,type=KINDS[label],label=LABELS[label],confidence=float(scores[index,label]),
                box=[x1/width,y1/height,(x2-x1)/width,(y2-y1)/height]))
    return output

class SCBDetector:
    def __init__(self,directory):
        import onnxruntime as ort
        directory=Path(directory);report=json.loads((directory/'scb-verification.json').read_text())
        if not report.get('prepared') or report.get('classes')!=list(CLASSES):raise ValueError('Prepare and verify SCB export first')
        for filename,key in [('scb5_read_write_yolov7.onnx','onnxSha256'),('scb5_read_write_yolov7.data','dataSha256')]:
            if hashlib.sha256((directory/filename).read_bytes()).hexdigest()!=report[key]:raise ValueError('SCB model checksum mismatch')
        options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
        options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
        options.add_session_config_entry('session.intra_op.allow_spinning','0')
        self.session=ort.InferenceSession(str(directory/'scb5_read_write_yolov7.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
    def predict(self,frame):
        image,transform=prepare_image(frame)
        return decode(self.session.run(None,{'images':image})[0],transform)
