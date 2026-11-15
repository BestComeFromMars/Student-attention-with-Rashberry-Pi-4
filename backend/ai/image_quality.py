"""Diagnostic pixel quality and a bounded low-light retry, without a quality veto."""
import cv2
import numpy as np


def enhance_low_light(image):
    """A bounded photometric retry; coordinates and original video stay intact."""
    if not image.size:
        return None
    sample = cv2.cvtColor(cv2.resize(image,(64,64),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2GRAY)
    p10,p95 = np.percentile(sample,[10,95])
    if float(sample.mean())>=90 or p95-p10<3:
        return None
    # Lift luminance only: multiplying dark RGB channels can saturate skin
    # colours and make a second face harder to detect after JPEG compression.
    lab = cv2.cvtColor(image,cv2.COLOR_BGR2LAB)
    gain = min(10.,max(1.,170/max(float(np.percentile(lab[:,:,0],[95])[0]),1.)))
    lab[:,:,0] = np.clip(lab[:,:,0].astype(np.float32)*gain,0,255).astype(np.uint8)
    lab[:,:,0] = cv2.createCLAHE(clipLimit=1.5,tileGridSize=(8,8)).apply(lab[:,:,0])
    return cv2.cvtColor(lab,cv2.COLOR_LAB2BGR)


def face_quality(frame, box):
    height,width = frame.shape[:2]
    x,y,w,h = box
    left,top = max(0,int(x*width)),max(0,int(y*height))
    right,bottom = min(width,int((x+w)*width)),min(height,int((y+h)*height))
    crop = frame[top:bottom,left:right]
    if not crop.size:
        return dict(usable=False,reason='empty',brightness=0.,contrast=0.,sharpness=0.)
    gray = cv2.cvtColor(cv2.resize(crop,(64,64),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2GRAY)
    p10,p90 = np.percentile(gray,[10,90])
    brightness = float(gray.mean())
    contrast = float(p90-p10)
    sharpness = float(cv2.Laplacian(gray,cv2.CV_32F).var())
    reason = ('too_dark' if brightness<35 and p90<70 else 'low_contrast' if contrast<12
              else 'blurred' if sharpness<12 else None)
    return dict(usable=reason is None,reason=reason,brightness=round(brightness,2),
                contrast=round(contrast,2),sharpness=round(sharpness,2))
