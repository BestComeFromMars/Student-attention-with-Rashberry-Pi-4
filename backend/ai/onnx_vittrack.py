"""OpenCV 4.11 VitTrack inference adapter using the same pretrained ONNX graph.

Crop, Hann window, tensor normalization and decode follow tracker_vit.cpp:
https://github.com/opencv/opencv/blob/4.11.0/modules/video/src/tracking/tracker_vit.cpp
Original author Pengyu Liu; OpenCV license Apache-2.0. See THIRD_PARTY_NOTICES.md.
One warmed ORT session is shared; templates/rectangles remain per track.
"""
from functools import lru_cache
import math
import cv2
import numpy as np
import onnxruntime as ort


@lru_cache(maxsize=2)
def runtime(path):
    options=ort.SessionOptions()
    # Dense face/object tracking shares this session across several threads.
    # Release temporary workspaces instead of retaining each thread's peak.
    options.enable_cpu_mem_arena=False
    options.enable_mem_pattern=False
    options.intra_op_num_threads=1
    options.inter_op_num_threads=1
    options.add_session_config_entry('session.intra_op.allow_spinning','0')
    options.add_session_config_entry('session.inter_op.allow_spinning','0')
    session=ort.InferenceSession(str(path),sess_options=options,providers=['CPUExecutionProvider'])
    session.run(None,{'template':np.zeros((1,3,128,128),np.float32),
                      'search':np.zeros((1,3,256,256),np.float32)})
    return session


# Match the pinned OpenCV 4.11 scalar reciprocal, including its channel signs.
# Changing preprocessing while changing runtime would also change tracking.
_std=np.array([.229,.224,.225],np.float64)
_scale=(_std*np.array([1.,-1.,-1.])/np.dot(_std,_std)/255).astype(np.float32)
_mean=(np.array([.485,.456,.406])*255).astype(np.float32)
_hann=(.5*(1-np.cos((np.float32(2*math.pi/17)*np.arange(1,17,dtype=np.float32))))).astype(np.float32)
_window=_hann[:,None]*_hann[None,:]


def crop(frame,box,factor):
    x,y,w,h=box
    size=math.ceil(math.sqrt(w*h)*factor)
    left=x+int((w-size)/2)
    top=y+int((h-size)/2)
    right,bottom=left+size,top+size
    height,width=frame.shape[:2]
    pl,pt=max(0,-left),max(0,-top)
    pr,pb=max(0,right-width+1),max(0,bottom-height+1)
    image=frame[top+pt:bottom-pb,left+pl:right-pr]
    if not image.size:
        return None,size
    return cv2.copyMakeBorder(image,pt,pb,pl,pr,cv2.BORDER_CONSTANT),size


def tensor(image,size):
    resized=cv2.resize(image,(size,size)).astype(np.float32)
    return np.ascontiguousarray(((resized-_mean)*_scale).transpose(2,0,1)[None])


class ONNXVitTrack:
    def __init__(self,path):
        self.session=runtime(str(path))
        self.score=0.

    def init(self,frame,box):
        image,_=crop(frame,box,2)
        self.template=tensor(image,128)
        self.box=tuple(box)

    def update(self,frame):
        image,size=crop(frame,self.box,4)
        if image is None:
            self.score=0.
            return False,self.box
        confidence,dimensions,offset=self.session.run(['output1','output2','output3'],
            {'template':self.template,'search':tensor(image,256)})
        confidence=confidence.reshape(16,16)*_window
        row,col=np.unravel_index(int(confidence.argmax()),confidence.shape)
        self.score=float(confidence[row,col])
        if self.score<.3:
            return False,self.box
        dimensions=dimensions.reshape(2,16,16)
        offset=offset.reshape(2,16,16)
        cx=(col+float(offset[0,row,col]))/16
        cy=(row+float(offset[1,row,col]))/16
        w,h=float(dimensions[0,row,col]),float(dimensions[1,row,col])
        x,y,bw,bh=self.box
        self.box=(math.floor((cx-w/2)*size+x+int((bw-size)/2)),
                  math.floor((cy-h/2)*size+y+int((bh-size)/2)),
                  math.floor(w*size),math.floor(h*size))
        return True,self.box

    def getTrackingScore(self):
        return self.score
