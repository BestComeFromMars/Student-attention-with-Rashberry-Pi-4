"""Lightweight NumPy containers matching Ultralytics Boxes/Keypoints interfaces."""
import numpy as np


class _ArrayView(np.ndarray):
    """NumPy ndarray view with .cpu() and .numpy() compatibility."""

    def __new__(cls, array):
        return np.asarray(array, dtype=np.float32).view(cls)

    def cpu(self):
        return self

    def numpy(self):
        return np.asarray(self)


class NumpyBoxes:
    """Drop-in replacement for ultralytics.engine.results.Boxes on CPU."""

    def __init__(self, data, orig_shape):
        arr = np.asarray(data, dtype=np.float32)
        if arr.size == 0:
            arr = arr.reshape(0, 6)
        self._data = arr
        self.orig_shape = tuple(orig_shape)

    @property
    def data(self):
        return _ArrayView(self._data)

    @property
    def xyxy(self):
        return _ArrayView(self._data[:, :4])

    @property
    def xywh(self):
        out = self._data[:, :4].copy()
        out[:, 2:] -= out[:, :2]
        out[:, :2] += out[:, 2:] * 0.5
        return _ArrayView(out)

    @property
    def conf(self):
        return _ArrayView(self._data[:, 4])

    @property
    def cls(self):
        return _ArrayView(self._data[:, 5])

    def numpy(self):
        return self

    def cpu(self):
        return self

    def __len__(self):
        return len(self._data)

    def __getitem__(self, item):
        return NumpyBoxes(self._data[item], self.orig_shape)


class NumpyKeypoints:
    """Drop-in replacement for ultralytics.engine.results.Keypoints on CPU."""

    def __init__(self, data, orig_shape):
        self._data = np.asarray(data, dtype=np.float32)
        self.orig_shape = tuple(orig_shape)

    @property
    def data(self):
        return _ArrayView(self._data)

    def __len__(self):
        return len(self._data)
