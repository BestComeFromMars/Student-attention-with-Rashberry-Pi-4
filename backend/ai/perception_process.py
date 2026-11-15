"""Isolate heavy behavior Python work from the latency-sensitive face tracker.

Models/measurements are unchanged. Bounded mailboxes carry sampled frames and
the latest timestamped observations; camera frames never form a long queue.
"""
import multiprocessing as mp
from queue import Empty, Full
import time
from types import SimpleNamespace


def latest_put(mailbox,value):
    try:
        mailbox.put_nowait(value)
        return True
    except Full:
        try:mailbox.get_nowait()
        except Empty:return False
        try:
            mailbox.put_nowait(value)
            return True
        except Full:return False


def run(models,frames,commands,results,export_native_lock=None):
    # Import PyTorch/MediaPipe only in this process, not in the tracker parent.
    import native_runtime
    native_runtime.EXPORT_NATIVE_LOCK=export_native_lock
    from perception import Perception
    analysis=None
    try:
        analysis=Perception(models)
        results.put(dict(type='ready',device=analysis.device,cavt=analysis.engagement.status,actions=analysis.actions.status,personLimit=analysis.person_limit,
            actionModel=analysis.actions.model_name,actionClasses=analysis.actions.class_count))
        sessions=set()
        released=set()
        stopped=False
        while not stopped:
            while True:
                try:command=commands.get_nowait()
                except Empty:break
                if command[0]=='stop':stopped=True;break
                if command[0]=='release':
                    session=command[1]
                    released.add(session);sessions.discard(session);analysis.release(session)
            if stopped:break
            try:
                session,frame,faces,body_only,at=frames.get(timeout=.015)
                if session not in released:
                    sessions.add(session);analysis.submit(session,frame,faces,at,body_only=body_only)
            except Empty:pass
            if not sessions:continue
            # One complete latest snapshot, including empty states, allows the
            # parent to discard old measurements after a face/session ends.
            latest_put(results,dict(type='snapshot',sessions={session:dict(
                observations=analysis.snapshot(session),objects=analysis.object_hints(session),restBodies=analysis.rest_bodies(session),**analysis.body_snapshot(session)) for session in sessions},
                error=analysis.error,personLimit=analysis.person_limit,timings={**analysis.timings,**analysis.actions.timings,'actionsStatus':analysis.actions.status,'actionsError':analysis.actions.error},cavt=analysis.engagement.status))
    except Exception as error:
        import traceback
        traceback.print_exc()
        latest_put(results,dict(type='error',error=str(error)))
    finally:
        if analysis is not None:analysis.close()
        results.cancel_join_thread()


class PerceptionProcess:
    def __init__(self,models):
        context=mp.get_context('spawn')
        self.frames=context.Queue(maxsize=1)
        self.commands=context.Queue(maxsize=128)
        self.results=context.Queue(maxsize=2)
        from native_runtime import EXPORT_NATIVE_LOCK
        self.process=context.Process(target=run,args=(str(models),self.frames,self.commands,self.results,EXPORT_NATIVE_LOCK),name='behavior-models')
        self.process.start()
        self.sessions=set()
        self.state={}
        self.submitted={}
        self.body_submitted={}
        self.last_faces={}
        self.timings={}
        self._error=None
        self.closed=False
        self.engagement=SimpleNamespace(status='loading')
        try:
            ready=self.results.get(timeout=85)
            if ready.get('type')!='ready':raise RuntimeError(ready.get('error','Behavior models failed to load'))
            self.device=ready['device'];self.engagement.status=ready['cavt']
            self.person_limit=ready.get('personLimit',40)
            self.actions_status=ready.get('actions','not_prepared')
            self.actions_model=ready.get('actionModel','MobileViCLIP-Tiny');self.actions_classes=ready.get('actionClasses',15)
        except Exception:
            self.close()
            raise

    def _drain(self):
        while True:
            try:message=self.results.get_nowait()
            except Empty:break
            if message['type']=='error':self._error=message['error']
            elif message['type']=='snapshot':
                self.person_limit=message.get('personLimit',getattr(self,'person_limit',40))
                self.state=message['sessions'];self.timings=message['timings']
                self._error=message['error'];self.engagement.status=message['cavt']
        if not self.closed and not self.process.is_alive():
            self._error='Behavior AI process exited ('+str(self.process.exitcode)+')'

    def submit(self,session,frame,faces,at,body_only=False):
        self.sessions.add(session)
        if body_only:
            if at-self.body_submitted.get(session,0)<100:return False
            if latest_put(self.frames,(session,frame,[],True,at)):
                self.body_submitted[session]=at;return True
            return False
        identities={face['id'] for face in faces}
        # 10 Hz is enough to supply fresh temporal evidence without copying a
        # full image at every native tracking update. Newly found faces bypass
        # this cadence. Behavior inference still uses the actual frame time.
        if at-self.submitted.get(session,0)<100 and identities==self.last_faces.get(session):return
        if latest_put(self.frames,(session,frame,faces,False,at)):
            self.submitted[session]=at;self.last_faces[session]=identities
            return True
        return False

    def snapshot(self,session):
        self._drain()
        return self.state.get(session,{}).get('observations',{}) if session in self.sessions else {}

    def body_hints(self,session):
        self._drain()
        return self.state.get(session,{}).get('bodies',[]) if session in self.sessions else []

    def object_hints(self,session):
        self._drain()
        return self.state.get(session,{}).get('objects',{}) if session in self.sessions else {}

    def rest_bodies(self,session):
        self._drain()
        return self.state.get(session,{}).get('restBodies',[]) if session in self.sessions else []

    def body_snapshot(self,session,wait_ms=0):
        # Only the first AI response requests this bounded wait. Camera frames
        # remain independent; later responses never wait for another scan.
        deadline=time.monotonic()+min(750,max(0,wait_ms))/1000
        while True:
            self._drain()
            state=self.state.get(session,{}) if session in self.sessions else {}
            snapshot=dict(bodies=state.get('bodies',[]),bodyAt=state.get('bodyAt',0),candidateCount=state.get('candidateCount',len(state.get('bodies',[]))))
            remaining=deadline-time.monotonic()
            if snapshot['bodyAt'] or remaining<=0 or self.closed or self._error or session not in self.sessions:return snapshot
            time.sleep(min(.01,remaining))

    @property
    def error(self):
        self._drain()
        return self._error

    def release(self,session):
        self.sessions.discard(session);self.state.pop(session,None)
        self.submitted.pop(session,None);self.last_faces.pop(session,None)
        self.body_submitted.pop(session,None)
        self.commands.put(('release',session),timeout=1)

    def close(self):
        if self.closed:return
        self.closed=True
        try:self.commands.put(('stop',),timeout=1)
        except Full:pass
        self.process.join(timeout=10)
        if self.process.is_alive():self.process.terminate();self.process.join(timeout=2)
        for mailbox in (self.frames,self.commands,self.results):
            mailbox.cancel_join_thread();mailbox.close()
