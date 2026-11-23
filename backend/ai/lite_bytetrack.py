"""Pure NumPy/LAP ByteTracker implementation without importing torch, scipy, or ultralytics."""
from collections import OrderedDict
import lap
import numpy as np


class TrackState:
    New = 0
    Tracked = 1
    Lost = 2
    Removed = 3


class BaseTrack:
    _count = 0

    def __init__(self):
        self.track_id = 0
        self.is_activated = False
        self.state = TrackState.New
        self.history = OrderedDict()
        self.features = []
        self.curr_feature = None
        self.score = 0
        self.start_frame = 0
        self.frame_id = 0
        self.time_since_update = 0
        self.location = (np.inf, np.inf)

    @property
    def end_frame(self):
        return self.frame_id

    @staticmethod
    def next_id():
        BaseTrack._count += 1
        return BaseTrack._count

    def mark_lost(self):
        self.state = TrackState.Lost

    def mark_removed(self):
        self.state = TrackState.Removed

    @staticmethod
    def reset_id():
        BaseTrack._count = 0


class KalmanFilterXYAH:
    def __init__(self):
        ndim, dt = 4, 1.0
        self._motion_mat = np.eye(2 * ndim, 2 * ndim)
        for i in range(ndim):
            self._motion_mat[i, ndim + i] = dt
        self._update_mat = np.eye(ndim, 2 * ndim)
        self._std_weight_position = 1.0 / 20
        self._std_weight_velocity = 1.0 / 160

    def initiate(self, measurement):
        mean_pos = measurement
        mean_vel = np.zeros_like(mean_pos)
        mean = np.r_[mean_pos, mean_vel]
        h = measurement[3]
        std = [
            2 * self._std_weight_position * h,
            2 * self._std_weight_position * h,
            1e-2,
            2 * self._std_weight_position * h,
            10 * self._std_weight_velocity * h,
            10 * self._std_weight_velocity * h,
            1e-5,
            10 * self._std_weight_velocity * h,
        ]
        return mean, np.diag(np.square(std))

    def predict(self, mean, covariance):
        h = mean[3]
        std_pos = [self._std_weight_position * h, self._std_weight_position * h, 1e-2, self._std_weight_position * h]
        std_vel = [self._std_weight_velocity * h, self._std_weight_velocity * h, 1e-5, self._std_weight_velocity * h]
        motion_cov = np.diag(np.square(np.r_[std_pos, std_vel]))
        mean = np.dot(mean, self._motion_mat.T)
        covariance = np.linalg.multi_dot((self._motion_mat, covariance, self._motion_mat.T)) + motion_cov
        return mean, covariance

    def multi_predict(self, mean, covariance):
        h = mean[:, 3]
        std_pos = [self._std_weight_position * h, self._std_weight_position * h, 1e-2 * np.ones_like(h), self._std_weight_position * h]
        std_vel = [self._std_weight_velocity * h, self._std_weight_velocity * h, 1e-5 * np.ones_like(h), self._std_weight_velocity * h]
        sqr = np.square(np.r_[std_pos, std_vel]).T
        motion_cov = np.array([np.diag(row) for row in sqr])
        mean = np.dot(mean, self._motion_mat.T)
        left = np.dot(self._motion_mat, covariance).transpose((1, 0, 2))
        covariance = np.dot(left, self._motion_mat.T) + motion_cov
        return mean, covariance

    def project(self, mean, covariance):
        h = mean[3]
        std = [self._std_weight_position * h, self._std_weight_position * h, 1e-1, self._std_weight_position * h]
        innovation_cov = np.diag(np.square(std))
        mean = np.dot(self._update_mat, mean)
        covariance = np.linalg.multi_dot((self._update_mat, covariance, self._update_mat.T))
        return mean, covariance + innovation_cov

    def update(self, mean, covariance, measurement):
        projected_mean, projected_cov = self.project(mean, covariance)
        kalman_gain = np.linalg.solve(projected_cov, np.dot(covariance, self._update_mat.T).T).T
        innovation = measurement - projected_mean
        new_mean = mean + np.dot(innovation, kalman_gain.T)
        new_covariance = covariance - np.linalg.multi_dot((kalman_gain, projected_cov, kalman_gain.T))
        return new_mean, new_covariance


def _xywh2ltwh(xywh):
    out = np.asarray(xywh, dtype=np.float32).copy()
    out[:2] -= out[2:] * 0.5
    return out


def _bbox_iou(a, b):
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    lt = np.maximum(a[:, None, :2], b[None, :, :2])
    rb = np.minimum(a[:, None, 2:], b[None, :, 2:])
    wh = np.maximum(0.0, rb - lt)
    inter = wh[:, :, 0] * wh[:, :, 1]
    area_a = np.maximum(0.0, a[:, 2] - a[:, 0]) * np.maximum(0.0, a[:, 3] - a[:, 1])
    area_b = np.maximum(0.0, b[:, 2] - b[:, 0]) * np.maximum(0.0, b[:, 3] - b[:, 1])
    return inter / np.maximum(1e-7, area_a[:, None] + area_b[None, :] - inter)


def _linear_assignment(cost_matrix, thresh):
    if cost_matrix.size == 0:
        return np.empty((0, 2), dtype=int), tuple(range(cost_matrix.shape[0])), tuple(range(cost_matrix.shape[1]))
    _, x, y = lap.lapjv(cost_matrix, extend_cost=True, cost_limit=thresh)
    matches = [[ix, mx] for ix, mx in enumerate(x) if mx >= 0]
    return matches, np.where(x < 0)[0], np.where(y < 0)[0]


def _iou_distance(atracks, btracks):
    atlbrs = atracks if (atracks and isinstance(atracks[0], np.ndarray)) else [t.xyxy for t in atracks]
    btlbrs = btracks if (btracks and isinstance(btracks[0], np.ndarray)) else [t.xyxy for t in btracks]
    ious = np.zeros((len(atlbrs), len(btlbrs)), dtype=np.float32)
    if len(atlbrs) and len(btlbrs):
        ious = _bbox_iou(np.ascontiguousarray(atlbrs, dtype=np.float32), np.ascontiguousarray(btlbrs, dtype=np.float32))
    return 1.0 - ious


def _fuse_score(cost_matrix, detections):
    if cost_matrix.size == 0:
        return cost_matrix
    iou_sim = 1.0 - cost_matrix
    det_scores = np.array([det.score for det in detections], dtype=np.float32)
    fuse_sim = iou_sim * np.expand_dims(det_scores, axis=0).repeat(cost_matrix.shape[0], axis=0)
    return 1.0 - fuse_sim


class STrack(BaseTrack):
    shared_kalman = KalmanFilterXYAH()

    def __init__(self, xywh, score, cls):
        super().__init__()
        self._tlwh = _xywh2ltwh(xywh[:4])
        self.kalman_filter = None
        self.mean, self.covariance = None, None
        self.is_activated = False
        self.score = float(score)
        self.tracklet_len = 0
        self.cls = cls
        self.idx = xywh[-1]
        self.angle = xywh[4] if len(xywh) == 6 else None

    @staticmethod
    def multi_predict(stracks):
        if not stracks:
            return
        multi_mean = np.asarray([st.mean.copy() for st in stracks])
        multi_cov = np.asarray([st.covariance for st in stracks])
        for i, st in enumerate(stracks):
            if st.state != TrackState.Tracked:
                multi_mean[i][7] = 0
        multi_mean, multi_cov = STrack.shared_kalman.multi_predict(multi_mean, multi_cov)
        for i, (mean, cov) in enumerate(zip(multi_mean, multi_cov)):
            stracks[i].mean = mean
            stracks[i].covariance = cov

    def activate(self, kalman_filter, frame_id):
        self.kalman_filter = kalman_filter
        self.track_id = self.next_id()
        self.mean, self.covariance = self.kalman_filter.initiate(self.tlwh_to_xyah(self._tlwh))
        self.tracklet_len = 0
        self.state = TrackState.Tracked
        if frame_id == 1:
            self.is_activated = True
        self.frame_id = frame_id
        self.start_frame = frame_id

    def re_activate(self, new_track, frame_id, new_id=False):
        self.mean, self.covariance = self.kalman_filter.update(self.mean, self.covariance, self.tlwh_to_xyah(new_track.tlwh))
        self.tracklet_len = 0
        self.state = TrackState.Tracked
        self.is_activated = True
        self.frame_id = frame_id
        if new_id:
            self.track_id = self.next_id()
        self.score = new_track.score
        self.cls = new_track.cls
        self.angle = new_track.angle
        self.idx = new_track.idx

    def update(self, new_track, frame_id):
        self.frame_id = frame_id
        self.tracklet_len += 1
        self.mean, self.covariance = self.kalman_filter.update(self.mean, self.covariance, self.tlwh_to_xyah(new_track.tlwh))
        self.state = TrackState.Tracked
        self.is_activated = True
        self.score = new_track.score
        self.cls = new_track.cls
        self.angle = new_track.angle
        self.idx = new_track.idx

    @property
    def tlwh(self):
        if self.mean is None:
            return self._tlwh.copy()
        ret = self.mean[:4].copy()
        ret[2] *= ret[3]
        ret[:2] -= ret[2:] / 2
        return ret

    @property
    def xyxy(self):
        ret = self.tlwh.copy()
        ret[2:] += ret[:2]
        return ret

    @staticmethod
    def tlwh_to_xyah(tlwh):
        ret = np.asarray(tlwh).copy()
        ret[:2] += ret[2:] / 2
        ret[2] /= max(1e-6, ret[3])
        return ret

    @property
    def result(self):
        return [*self.xyxy.tolist(), self.track_id, self.score, self.cls, self.idx]


class BYTETracker:
    def __init__(self, args, frame_rate=30):
        self.tracked_stracks = []
        self.lost_stracks = []
        self.removed_stracks = []
        self.frame_id = 0
        self.args = args
        self.max_time_lost = int(frame_rate / 30.0 * args.track_buffer)
        self.kalman_filter = KalmanFilterXYAH()
        self.reset_id()

    def update(self, results, img=None, feats=None):
        self.frame_id += 1
        activated_stracks, refind_stracks, lost_stracks, removed_stracks = [], [], [], []
        scores = results.conf.numpy() if hasattr(results.conf, 'numpy') else np.asarray(results.conf)
        remain_inds = scores >= self.args.track_high_thresh
        inds_second = (scores > self.args.track_low_thresh) & (scores < self.args.track_high_thresh)
        results_second = results[inds_second]
        results_high = results[remain_inds]
        detections = self.init_track(results_high)
        unconfirmed = [t for t in self.tracked_stracks if not t.is_activated]
        tracked_stracks = [t for t in self.tracked_stracks if t.is_activated]
        strack_pool = self.joint_stracks(tracked_stracks, self.lost_stracks)
        STrack.multi_predict(strack_pool)
        dists = self.get_dists(strack_pool, detections)
        matches, u_track, u_detection = _linear_assignment(dists, thresh=self.args.match_thresh)
        for itracked, idet in matches:
            track, det = strack_pool[itracked], detections[idet]
            if track.state == TrackState.Tracked:
                track.update(det, self.frame_id); activated_stracks.append(track)
            else:
                track.re_activate(det, self.frame_id, new_id=False); refind_stracks.append(track)
        detections_second = self.init_track(results_second)
        r_tracked_stracks = [strack_pool[i] for i in u_track if strack_pool[i].state == TrackState.Tracked]
        dists = _iou_distance(r_tracked_stracks, detections_second)
        matches, u_track, _ = _linear_assignment(dists, thresh=0.5)
        for itracked, idet in matches:
            track, det = r_tracked_stracks[itracked], detections_second[idet]
            if track.state == TrackState.Tracked:
                track.update(det, self.frame_id); activated_stracks.append(track)
            else:
                track.re_activate(det, self.frame_id, new_id=False); refind_stracks.append(track)
        for it in u_track:
            track = r_tracked_stracks[it]
            if track.state != TrackState.Lost:
                track.mark_lost(); lost_stracks.append(track)
        detections = [detections[i] for i in u_detection]
        dists = self.get_dists(unconfirmed, detections)
        matches, u_unconfirmed, u_detection = _linear_assignment(dists, thresh=0.7)
        for itracked, idet in matches:
            unconfirmed[itracked].update(detections[idet], self.frame_id); activated_stracks.append(unconfirmed[itracked])
        for it in u_unconfirmed:
            track = unconfirmed[it]; track.mark_removed(); removed_stracks.append(track)
        for inew in u_detection:
            track = detections[inew]
            if track.score >= self.args.new_track_thresh:
                track.activate(self.kalman_filter, self.frame_id); activated_stracks.append(track)
        for track in self.lost_stracks:
            if self.frame_id - track.end_frame > self.max_time_lost:
                track.mark_removed(); removed_stracks.append(track)
        self.tracked_stracks = [t for t in self.tracked_stracks if t.state == TrackState.Tracked]
        self.tracked_stracks = self.joint_stracks(self.tracked_stracks, activated_stracks)
        self.tracked_stracks = self.joint_stracks(self.tracked_stracks, refind_stracks)
        self.lost_stracks = self.sub_stracks(self.lost_stracks, self.tracked_stracks)
        self.lost_stracks.extend(lost_stracks)
        self.lost_stracks = self.sub_stracks(self.lost_stracks, self.removed_stracks)
        self.tracked_stracks, self.lost_stracks = self.remove_duplicate_stracks(self.tracked_stracks, self.lost_stracks)
        self.removed_stracks.extend(removed_stracks)
        if len(self.removed_stracks) > 1000:
            self.removed_stracks = self.removed_stracks[-999:]
        return np.asarray([x.result for x in self.tracked_stracks if x.is_activated], dtype=np.float32)

    def init_track(self, results):
        if len(results) == 0:
            return []
        xywh = results.xywh.numpy() if hasattr(results.xywh, 'numpy') else np.asarray(results.xywh)
        conf = results.conf.numpy() if hasattr(results.conf, 'numpy') else np.asarray(results.conf)
        cls = results.cls.numpy() if hasattr(results.cls, 'numpy') else np.asarray(results.cls)
        bboxes = np.concatenate([xywh, np.arange(len(xywh)).reshape(-1, 1)], axis=-1)
        return [STrack(box, s, c) for box, s, c in zip(bboxes, conf, cls)]

    def get_dists(self, tracks, detections):
        dists = _iou_distance(tracks, detections)
        return _fuse_score(dists, detections) if self.args.fuse_score else dists

    @staticmethod
    def reset_id():
        STrack.reset_id()

    @staticmethod
    def joint_stracks(tlista, tlistb):
        exists = {t.track_id: 1 for t in tlista}
        res = list(tlista)
        for t in tlistb:
            if not exists.get(t.track_id, 0):
                exists[t.track_id] = 1
                res.append(t)
        return res

    @staticmethod
    def sub_stracks(tlista, tlistb):
        track_ids_b = {t.track_id for t in tlistb}
        return [t for t in tlista if t.track_id not in track_ids_b]

    @staticmethod
    def remove_duplicate_stracks(stracksa, stracksb):
        pdist = _iou_distance(stracksa, stracksb)
        pairs = np.where(pdist < 0.15)
        dupa, dupb = [], []
        for p, q in zip(*pairs):
            if stracksa[p].frame_id - stracksa[p].start_frame > stracksb[q].frame_id - stracksb[q].start_frame:
                dupb.append(q)
            else:
                dupa.append(p)
        return [t for i, t in enumerate(stracksa) if i not in dupa], [t for i, t in enumerate(stracksb) if i not in dupb]
