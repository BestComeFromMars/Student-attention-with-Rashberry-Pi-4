"""Uncapped person admission by default; auto-reduces only under real memory pressure.

Detects every student present in the frame without artificial per-person RAM
quotas. Automatically scales down only when OS available memory drops below a
critical floor (384 MB) or when an actual MemoryError/OOM occurs.
"""
import ctypes
import os
import time
import psutil

MB = 1024 ** 2
DEFAULT_CEILING = 100
CRITICAL_FLOOR_MB = 192.0
RECOVER_FLOOR_MB = 384.0


def memory_sample():
    memory = psutil.virtual_memory()
    available = memory.available / MB
    if os.name == 'nt':
        class Status(ctypes.Structure):
            _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [
                (name, ctypes.c_ulonglong)
                for name in ('totalPhys', 'availPhys', 'totalPage', 'availPage', 'totalVirt', 'availVirt', 'availExt')
            ]
        status = Status()
        status.length = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            available = min(available, status.availPage / MB)
    return memory.total / MB, available


def select_people(items, limit, preferred=()):
    """Retain established IDs, then admit the clearest remaining candidates."""
    if len(items) <= limit:
        return list(items)
    preferred = set(preferred)
    return sorted(
        items,
        key=lambda item: (item.get('id') not in preferred, -float(item.get('confidence', item.get('score', 0)))),
    )[:max(1, limit)]


class MemoryBudget:
    def __init__(self, sample=memory_sample, clock=time.monotonic):
        self.sample = sample
        self.clock = clock
        self.checked = -float('inf')
        self.raised = -float('inf')
        self.total = 0
        self.available = 0
        self.ceiling = DEFAULT_CEILING
        self.limit = DEFAULT_CEILING
        self.pressure = False
        self.update()

    def update(self, active=0):
        now = self.clock()
        if now - self.checked < 2:
            return self.limit
        initial = self.checked == -float('inf')
        self.checked = now
        self.total, self.available = self.sample()
        self.ceiling = DEFAULT_CEILING
        self.pressure = self.available < CRITICAL_FLOOR_MB
        if self.pressure:
            # Real low-memory emergency: shed load smoothly without stopping camera.
            base = active if active > 0 else self.limit
            target = max(4, base // 2) if self.available > 128 else 1
            self.limit = min(self.limit, target) if not initial else target
            self.raised = now
        elif initial:
            self.limit = self.ceiling
            self.raised = now
        elif self.limit < self.ceiling and self.available >= RECOVER_FLOOR_MB and now - self.raised >= 3:
            self.limit = min(self.ceiling, self.limit + 8)
            self.raised = now
        return self.limit

    def reduce(self):
        self.limit = max(1, self.limit // 2)
        self.pressure = True
        self.raised = self.clock()

    def status(self, detected=0, processed=0, limit=None):
        limit = self.limit if limit is None else limit
        return dict(
            totalMB=round(self.total),
            availableMB=max(0, round(self.available)),
            limit=limit,
            detected=detected,
            processed=processed,
            limited=detected > limit,
            pressure=self.pressure,
        )
