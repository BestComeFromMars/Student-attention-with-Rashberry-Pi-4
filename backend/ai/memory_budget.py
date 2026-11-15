"""Conservative admission budget; lower concurrency rather than stop the camera.

The per-person allowance is a safety estimate, not a measured hardware guarantee.
Model base memory and other applications are accounted for by OS available RAM.
"""
import ctypes
import os
import time
import psutil

MB=1024**2

def memory_sample():
    memory=psutil.virtual_memory()
    available=memory.available/MB
    if os.name=='nt':
        class Status(ctypes.Structure):
            _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(name,ctypes.c_ulonglong) for name in
                ('totalPhys','availPhys','totalPage','availPage','totalVirt','availVirt','availExt')]
        status=Status();status.length=ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            available=min(available,status.availPage/MB)
    return memory.total/MB,available

def select_people(items,limit,preferred=()):
    """Retain established IDs, then admit the clearest remaining candidates."""
    if len(items)<=limit:return list(items)
    preferred=set(preferred)
    return sorted(items,key=lambda item:(item.get('id') not in preferred,-float(item.get('confidence',item.get('score',0)))))[:max(1,limit)]

class MemoryBudget:
    def __init__(self,sample=memory_sample,clock=time.monotonic):
        self.sample=sample;self.clock=clock;self.checked=-float('inf');self.raised=-float('inf')
        self.total=0;self.available=0;self.limit=1;self.ceiling=1;self.pressure=False
        self.update()

    def update(self,active=0):
        now=self.clock()
        if now-self.checked<2:return self.limit
        initial=self.checked==-float('inf');self.checked=now
        self.total,self.available=self.sample()
        nominal=max(1,round(self.total/1024))
        self.ceiling=min(40,max(1,nominal*5//2))
        reserve=max(768,min(2048,self.total*.1))
        active=min(active,self.limit)
        target=max(1,min(self.ceiling,active+int((self.available-reserve)//64)))
        self.pressure=self.available<reserve
        if initial or target<self.limit:self.limit=target;self.raised=now
        elif target>self.limit and self.available>reserve+256 and now-self.raised>=10:
            self.limit=min(target,self.limit+2);self.raised=now
        return self.limit

    def reduce(self):
        self.limit=max(1,self.limit//2);self.pressure=True;self.raised=self.clock()

    def status(self,detected=0,processed=0,limit=None):
        limit=self.limit if limit is None else limit
        return dict(totalMB=round(self.total),availableMB=max(0,round(self.available)),limit=limit,
                    detected=detected,processed=processed,limited=detected>limit,pressure=self.pressure)
