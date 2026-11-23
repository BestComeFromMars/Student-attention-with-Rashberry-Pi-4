"""YOLO11 ONNX decoding using OpenCV DNN or ONNX Runtime without importing torch."""
from types import SimpleNamespace
import cv2
import numpy as np
from light_results import NumpyBoxes, NumpyKeypoints


class OpenCVYOLO:
    def __init__(self,path,pose=False):
        self.net=cv2.dnn.readNetFromONNX(str(path))
        # Winograd keeps expanded convolution buffers for all three networks.
        # Direct convolutions leave room for the camera and face landmarks on CPU.
        self.net.enableWinograd(False)
        self.net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        self.net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.pose=pose

    def predict(self,frame,imgsz=640,classes=None,conf=.25,**kwargs):
        height,width=frame.shape[:2]
        scale=min(640/width,640/height)
        nw,nh=round(width*scale),round(height*scale)
        left,top=(640-nw)//2,(640-nh)//2
        image=np.full((640,640,3),114,np.uint8)
        image[top:top+nh,left:left+nw]=cv2.resize(frame,(nw,nh))
        blob=cv2.dnn.blobFromImage(image,1/255.,(640,640),swapRB=True,crop=False)
        if hasattr(self.net,'run_blob'):
            prediction=self.net.run_blob(blob)
        else:
            self.net.setInput(blob)
            prediction=self.net.forward()
        if isinstance(prediction,(tuple,list)):
            prediction=prediction[0]
        rows=prediction[0].T
        scores=rows[:,4:5] if self.pose else rows[:,4:84]
        class_ids=scores.argmax(axis=1)
        confidence=scores[np.arange(len(rows)),class_ids]
        mask=confidence>=conf
        if classes is not None:
            mask &= np.isin(class_ids,classes)
        rows,class_ids,confidence=rows[mask],class_ids[mask],confidence[mask]
        xywh=rows[:,:4].copy()
        xywh[:,:2]-=xywh[:,2:]/2
        kept=[]
        for cls in np.unique(class_ids):
            candidates=np.flatnonzero(class_ids==cls)
            indices=cv2.dnn.NMSBoxes(xywh[candidates].tolist(),confidence[candidates].tolist(),conf,.7)
            kept.extend(candidates[np.asarray(indices,dtype=int).reshape(-1)].tolist())
        kept=sorted(kept,key=lambda index:-confidence[index])[:100]
        detections=np.empty((len(kept),6),np.float32)
        keypoints=[]
        for output,index in enumerate(kept):
            x,y,w,h=xywh[index]
            detections[output]=[max(0,(x-left)/scale),max(0,(y-top)/scale),
                min(width,(x+w-left)/scale),min(height,(y+h-top)/scale),confidence[index],class_ids[index]]
            if self.pose:
                points=rows[index,5:].reshape(17,3).copy()
                points[:,0]=(points[:,0]-left)/scale
                points[:,1]=(points[:,1]-top)/scale
                keypoints.append(points)
        result=SimpleNamespace(boxes=NumpyBoxes(detections,frame.shape[:2]),keypoints=None)
        if self.pose and keypoints:
            result.keypoints=NumpyKeypoints(np.asarray(keypoints,np.float32),frame.shape[:2])
        return [result]
