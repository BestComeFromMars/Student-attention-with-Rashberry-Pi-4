"""Official SCRFD ONNX detectors with five keypoints, one CPU thread.

Production weights: buffalo_l/det_10g.onnx, non-commercial research license.
RGB normalization and stride/anchor layout follow the upstream SCRFD model
specification. This adapter returns the existing detector's 15-column layout.
"""
import cv2
import numpy as np
import onnxruntime as ort
from image_quality import enhance_low_light
from native_runtime import export_serialized


def decode_level(scores, distances, landmarks, height, width, stride, threshold):
    scores = np.asarray(scores).reshape(-1)
    indices = np.flatnonzero(scores >= threshold)
    if not len(indices):
        return np.empty((0, 15), np.float32)
    centers = np.stack(np.mgrid[:height//stride, :width//stride][::-1], axis=-1)
    centers = np.repeat(centers.reshape(-1, 2), 2, axis=0).astype(np.float32)*stride
    centers = centers[indices]
    distances = np.asarray(distances).reshape(-1, 4)[indices]*stride
    points = np.asarray(landmarks).reshape(-1, 5, 2)[indices]*stride + centers[:, None, :]
    left_top = centers-distances[:, :2]
    right_bottom = centers+distances[:, 2:]
    return np.column_stack((left_top, right_bottom-left_top, points.reshape(-1, 10), scores[indices]))


class SCRFD:
    def __init__(self, path, threshold=.5):
        options = ort.SessionOptions()
        options.log_severity_level = 3  # upstream outputs declare VGA shapes; inference is dynamic
        # Rescans use several image sizes. Do not retain a large arena for each
        # session/shape beside the already loaded behavior models.
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
        self.input = self.session.get_inputs()[0].name
        self.outputs = [item.name for item in self.session.get_outputs()]
        if len(self.outputs) != 9:
            raise ValueError('Expected SCRFD with three strides and five keypoints')
        self.threshold = threshold

    def setInputSize(self, size):
        pass  # FaceGeometry pads each dynamic input axis to 32

    def detect(self, image):
        height, width = image.shape[:2]
        blob = cv2.dnn.blobFromImage(image, 1/128., (width, height), (127.5, 127.5, 127.5), swapRB=True)
        output = self.session.run(self.outputs, {self.input: blob})
        rows = np.concatenate([decode_level(output[i], output[i+3], output[i+6], height, width, stride, self.threshold)
                               for i, stride in enumerate((8, 16, 32))])
        if not len(rows):
            return None, None
        keep = cv2.dnn.NMSBoxes(rows[:, :4].tolist(), rows[:, -1].tolist(), self.threshold, .3)
        return None, rows[np.asarray(keep, dtype=int).reshape(-1)]


class VerifiedFaceDetector:
    """Fuse the two detectors; a missing result must not veto the other model.

    Matched faces keep YuNet anchors used by the existing behavior pipeline.
    Weak/unmatched candidates remain available for mesh confirmation.
    """
    def __init__(self, model_path):
        from pathlib import Path
        self.yunet = cv2.FaceDetectorYN.create(str(Path(model_path).with_name('face_detection_yunet_2023mar.onnx')),
                                             '', (320, 320), .65, .3, 5000)
        self.scrfd = SCRFD(model_path)
        self.strong_model = Path(model_path).name=='scrfd_10g.onnx'
        self.evidence = []

    def setInputSize(self, size):
        self.yunet.setInputSize(size)

    @export_serialized
    def detect(self, image):
        _, candidates = self.yunet.detect(image)
        _, independent = self.scrfd.detect(image)
        primary=getattr(self,'strong_model',False)
        rows, self.evidence = fuse_faces(candidates, independent,prefer_scrfd=primary)
        enhanced = enhance_low_light(image)
        if enhanced is not None:
            _, extra_yunet = self.yunet.detect(enhanced)
            # A verified bright YuNet candidate does not prove that every face
            # was found. SCRFD must also see the brighter image, otherwise one
            # well-lit person can prevent recovery of their darker neighbour.
            _, extra_scrfd = self.scrfd.detect(enhanced)
            extra, support = fuse_faces(extra_yunet,extra_scrfd,prefer_scrfd=primary)
            merged = list(rows)
            for row,evidence in zip(extra,support):
                matches = [(overlap(row,other),index) for index,other in enumerate(merged)]
                best,index = max(matches,default=(0.,-1))
                if best>=.3:
                    # Prefer already verified raw geometry. Never count the
                    # exposure retry as another temporal detector confirmation.
                    if not self.evidence[index]['detectorVerified'] and evidence['detectorVerified']:
                        merged[index] = row
                        self.evidence[index] = dict(evidence,enhanced=True)
                else:
                    merged.append(row)
                    self.evidence.append(dict(evidence,enhanced=True))
            rows = np.asarray(merged,dtype=np.float32).reshape(-1,15)
        if getattr(self,'strong_model',False):
            for row,evidence in zip(rows,self.evidence):
                evidence['detectorModel']='SCRFD-10G'
                # Trust the pretrained detector for profile presence; frontal
                # landmark ordering belongs to behavior measurement, not here.
                if evidence.get('scrfdScore',0)>=.75 and np.isfinite(row).all():
                    evidence['detectorVerified']=True
        return None, rows if len(rows) else None


def overlap(a, b):
    x,y,w,h = a[:4]
    ox,oy,ow,oh = b[:4]
    area = max(0,min(x+w,ox+ow)-max(x,ox))*max(0,min(y+h,oy+oh)-max(y,oy))
    return area/max(1e-8,w*h+ow*oh-area)


def plausible_points(row):
    if len(row) != 15 or not np.isfinite(row).all():
        return False
    x,y,w,h = row[:4]
    if w<=0 or h<=0:
        return False
    points = row[4:14].reshape(5,2)
    eyes,mouth = points[:2].mean(axis=0),points[3:].mean(axis=0)
    # Profile eyes may be close together; do not enforce frontal symmetry.
    return bool(np.all(points[:,0]>=x-.15*w) and np.all(points[:,0]<=x+1.15*w) and
                np.all(points[:,1]>=y-.15*h) and np.all(points[:,1]<=y+1.15*h) and
                eyes[1]+.12*h < mouth[1] and eyes[1]-.1*h <= points[2,1] <= mouth[1]+.1*h)


def fuse_faces(yunet, scrfd, prefer_scrfd=False):
    first = [] if yunet is None else list(yunet)
    second = [] if scrfd is None else list(scrfd)
    matches = sorted([(overlap(a,b),i,j) for i,a in enumerate(first) for j,b in enumerate(second)
                      if overlap(a,b)>=.3],reverse=True)
    paired,used = {},set()
    for _,i,j in matches:
        if i not in paired and j not in used:
            paired[i]=j;used.add(j)
    rows,evidence = [],[]
    for i,row in enumerate(first):
        other = second[paired[i]] if i in paired else None
        verified = bool(other is not None and row[-1]>=.70 and other[-1]>=.65 and
                        plausible_points(row) and plausible_points(other))
        # A single source of box geometry avoids changing padding/aspect when
        # YuNet appears or disappears. Keep its landmark anchors for behavior.
        geometry=np.array(row,copy=True)
        if prefer_scrfd and other is not None:
            geometry[:4]=other[:4]
            geometry[-1]=other[-1]
        rows.append(geometry)
        evidence.append(dict(detectorVerified=verified,evidenceMode='dual' if other is not None else 'yunet',
                             scrfdScore=float(other[-1]) if other is not None else 0.))
    for j,row in enumerate(second):
        if j in used:
            continue
        rows.append(row)
        evidence.append(dict(detectorVerified=bool(row[-1]>=.75 and plausible_points(row)),
                             evidenceMode='scrfd',scrfdScore=float(row[-1])))
    return np.asarray(rows,dtype=np.float32).reshape(-1,15),evidence


def supported_face(candidate, evidence):
    x, y, w, h = candidate[:4]
    for other in evidence:
        ox, oy, ow, oh = other[:4]
        overlap = max(0, min(x+w, ox+ow)-max(x, ox))*max(0, min(y+h, oy+oh)-max(y, oy))
        if overlap/max(1e-8, w*h+ow*oh-overlap) >= .3:
            return True
    return False
