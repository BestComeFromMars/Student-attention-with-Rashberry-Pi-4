"""Causal per-person video inference. Cosine scores are not probabilities."""
from collections import deque
import ctypes,hashlib,json,os,threading,time
from pathlib import Path
import cv2
import numpy as np
import psutil

LABEL_PATH=Path(__file__).with_name('action_labels.json')
LABELS=json.loads(LABEL_PATH.read_text(encoding='utf-8'))

def private_tree_mb():
    process=psutil.Process()
    try:root=process.parent() if process.parent() and 'python' in process.parent().name().lower() else process
    except psutil.Error:root=process
    total=0
    for item in [root,*root.children(recursive=True)]:
        try:
            info=item.memory_info();total+=getattr(info,'private',info.rss)
        except psutil.Error:pass
    return total/2**20

def commit_available_mb():
    if os.name!='nt':return psutil.virtual_memory().available/2**20
    class Memory(ctypes.Structure):
        _fields_=[('length',ctypes.c_ulong),('load',ctypes.c_ulong)]+[(key,ctypes.c_ulonglong) for key in ('totalPhys','availPhys','totalPage','availPage','totalVirt','availVirt','availExt')]
    value=Memory();value.length=ctypes.sizeof(value);ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value))
    return value.availPage/2**20

class ActionRecognizer:
    model_name='MobileViCLIP-Tiny';class_count=15
    def __init__(self,directory):
        self.lock=threading.Lock();self.stop=threading.Event();self.frames={};self.jobs={};self.results={};self.submitted={}
        self.status='not_prepared';self.error=None;self.busy=False;self.session=None;self.thread=None;self.timings={};self.pair=None
        directory=Path(directory)
        try:
            report=json.loads((directory/'verification.json').read_text())
            if not report.get('ready'):return
            if not report.get('trainedTextOverlayApplied'):
                self.status='needs_preparation';return
            runtime=directory/'runtime-2.json'
            capacity=json.loads(runtime.read_text()) if runtime.exists() else {}
            # The default still supports classrooms of up to 40 people. A
            # successful one-person tensor test is not a dense-classroom pass.
            if capacity.get('maxPeopleAt2sCadence',0)<40 and os.environ.get('AI_ACTIONS_EXPERIMENTAL')!='1':
                self.status='experimental_only';return
            if hashlib.sha256(LABEL_PATH.read_bytes()).hexdigest()!=report['labelSha256']:raise ValueError('Prepare action prompts again: checksum changed')
            for name,digest in report['files'].items():
                if hashlib.sha256((directory/name).read_bytes()).hexdigest()!=digest:raise ValueError('Action model checksum mismatch: '+name)
            import onnxruntime as ort
            options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
            options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
            options.add_session_config_entry('session.intra_op.allow_spinning','0')
            self.session=ort.InferenceSession(str(directory/'mobileviclip_tiny.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
            self.text=np.load(directory/'action_text.npy',allow_pickle=False)
            if self.text.shape!=(len(LABELS)*2,512):raise ValueError('Invalid prompt vectors')
            self.status='ready';self.thread=threading.Thread(target=self._loop,name='person-actions',daemon=False);self.thread.start()
        except FileNotFoundError:pass
        except Exception as error:self.status='error';self.error=str(error);self.session=None
    def observe(self,session,frame,bodies,at):
        if self.session is None:return
        height,width=frame.shape[:2]
        with self.lock:
            alive={(session,b['id']) for b in bodies}
            for storage in (self.frames,self.results,self.jobs,self.submitted):
                for key in list(storage):
                    if key[0]==session and key not in alive:storage.pop(key,None)
            for body in bodies:
                key=(session,body['id']);history=self.frames.setdefault(key,deque(maxlen=8))
                if history and (at<history[-1][0] or at-history[-1][0]>2000):history.clear()
                if history and at-history[-1][0]<180:continue
                x,y,w,h=body['box'];left,top=max(0,int((x-.1*w)*width)),max(0,int((y-.05*h)*height))
                right,bottom=min(width,int((x+1.1*w)*width)),min(height,int((y+1.05*h)*height))
                if right-left<20 or bottom-top<20:continue
                crop=cv2.cvtColor(cv2.resize(frame[top:bottom,left:right],(256,256),interpolation=cv2.INTER_CUBIC),cv2.COLOR_BGR2RGB)
                history.append((at,crop))
                if len(history)==8 and at-self.submitted.get(key,-100000)>500:
                    self.jobs[key]=(list(history),at);self.submitted[key]=at
    def _loop(self):
        while not self.stop.wait(.02):
            with self.lock:
                if not self.jobs:continue
                key=self.pair if self.pair in self.jobs else next(iter(self.jobs));history,at=self.jobs.pop(key)
                self.pair=None if key==self.pair else key
            # Measured extra peak of this artifact: 155 MB; leave a 100 MB
            # margin beyond that, while preserving the 2 GB whole-AI budget.
            if commit_available_mb()<256 or private_tree_mb()>1848:self.error='memory_budget';continue
            try:
                self.busy=True;started=time.perf_counter()
                images=np.stack([entry[1] for entry in history]).astype(np.float32)/255
                images=(images-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
                video=np.ascontiguousarray(images.transpose(3,0,1,2)[None])
                # ONNX uses no Torch kernels. Waiting on the CavT training-
                # runtime lock could make a new action stale before it ran.
                embedding=self.session.run(None,{'video':video})[0].reshape(-1)
                embedding/=max(float(np.linalg.norm(embedding)),1e-8)
                scores=(self.text@embedding).reshape(-1,2);actions=[]
                for label,pair in zip(LABELS,scores):
                    margin=float(pair[0]-pair[1]);present=float(pair[0])>=.15 and margin>=.025
                    actions.append(dict(type=label['type'],label=label['label'],state='pending' if present else 'clear',source='MobileViCLIP-Tiny',
                        observedAt=at,clipStart=history[0][0],similarity=float(pair[0]),margin=margin))
                for first,second in ((0,1),(2,3)):
                    if actions[first]['state']==actions[second]['state']=='pending':
                        actions[first if actions[first]['margin']<actions[second]['margin'] else second]['state']='clear'
                with self.lock:
                    if key in self.frames:self.results[key]=actions
                self.timings=dict(actionMs=round((time.perf_counter()-started)*1000,2),actionQueued=len(self.jobs));self.error=None
            except Exception as error:self.error=str(error)
            finally:self.busy=False
    def snapshot(self,session,identity,now):
        with self.lock:results=self.results.get((session,identity))
        if results and 0<=now-results[0]['observedAt']<=2500 and not self.error:return [dict(a) for a in results]
        return [dict(type=a['type'],label=a['label'],state='unavailable',source='MobileViCLIP-Tiny',observedAt=now,
            reason=self.error or (self.status if self.status!='ready' else 'collecting_causal_frames')) for a in LABELS]
    def release(self,session):
        with self.lock:
            for storage in (self.frames,self.jobs,self.results,self.submitted):
                for key in list(storage):
                    if key[0]==session:storage.pop(key,None)
    def close(self):
        self.stop.set()
        if self.thread:self.thread.join(timeout=10)
