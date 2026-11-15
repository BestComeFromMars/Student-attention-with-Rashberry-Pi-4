"""Avoid overlapping CPU BLAS calls across the YOLO and CavT worker threads."""
import threading
from functools import wraps
TORCH_LOCK=threading.RLock()
EXPORT_NATIVE_LOCK=None


def export_serialized(function):
    """Optional shared lock for memory-bounded offline exports, no model changes."""
    @wraps(function)
    def call(*args,**kwargs):
        if EXPORT_NATIVE_LOCK is None:
            return function(*args,**kwargs)
        with EXPORT_NATIVE_LOCK:
            return function(*args,**kwargs)
    return call


def serialized(function):
    @wraps(function)
    def call(*args,**kwargs):
        with TORCH_LOCK:
            return function(*args,**kwargs)
    return call
