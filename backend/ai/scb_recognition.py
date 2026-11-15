"""Opt-in SCB observations attached to existing person IDs, with latest-only work."""
import os,threading,time
from scipy.optimize import linear_sum_assignment
import numpy as np
from scb_detection import SCBDetector,KINDS,LABELS
from geometry import iou
from action_recognition import private_tree_mb,commit_available_mb

def attach_actions(bodies,detections,at):
    output={body['id']:[dict(type=kind,label=label,state='clear',source='SCB-YOLOv7',observedAt=at) for kind,label in zip(KINDS,LABELS)] for body in bodies}
    for label,kind in enumerate(KINDS):
        candidates=[d for d in detections if d['type']==kind];cost=np.full((len(bodies),len(candidates)),len(bodies)+len(candidates)+1.)
        for di,detection in enumerate(candidates):
            scores=sorted(((iou(body['box'],detection['box']),bi) for bi,body in enumerate(bodies)),reverse=True)
            if not scores or scores[0][0]<.25:continue
            if len(scores)>1 and scores[0][0]-scores[1][0]<.1:
                for score,bi in scores:
                    if score>=.25:output[bodies[bi]['id']][label].update(state='unavailable',reason='ambiguous_person')
                continue
            score,bi=scores[0];cost[bi,di]=1-score
        if cost.size:
            rows,cols=linear_sum_assignment(cost)
            for bi,di in zip(rows,cols):
                if cost[bi,di]>.75:continue
                detection=candidates[di];output[bodies[bi]['id']][label].update(state='pending',confidence=detection['confidence'],
                    evidenceBox=dict(zip(('x','y','width','height'),detection['box'])))
    return output

class SCBRecognizer:
    model_name='SCB-YOLOv7';class_count=3
    def __init__(self,directory):
        self.status='experimental_only';self.error=None;self.busy=False;self.timings={};self.latest={};self.results={};self.submitted={};self.generations={}
        self.lock=threading.Lock();self.stop=threading.Event();self.thread=None;self.detector=None
        if os.environ.get('AI_CLASSROOM_ACTIONS')!='1':return
        try:
            self.detector=SCBDetector(directory);self.status='ready'
            self.thread=threading.Thread(target=self._loop,name='classroom-actions',daemon=False);self.thread.start()
        except Exception as error:self.status='error';self.error=str(error)
    def observe(self,session,frame,bodies,at):
        if self.detector is None:return
        with self.lock:
            if at-self.submitted.get(session,-100000)<700:return
            self.submitted[session]=at
            fresh=[dict(body) for body in bodies if 0<=at-body.get('at',-100000)<=1000]
            self.latest[session]=(frame,fresh,at,self.generations.get(session,0))
    def _loop(self):
        while not self.stop.wait(.02):
            with self.lock:
                if not self.latest:continue
                session=next(iter(self.latest));frame,bodies,at,generation=self.latest.pop(session)
            # Leave the measured ORT workspace and a margin inside the whole-AI budget.
            if private_tree_mb()>1600 or commit_available_mb()<450:self.error='memory_budget';continue
            try:
                self.busy=True;started=time.perf_counter();detections=self.detector.predict(frame)
                result=attach_actions(bodies,detections,at)
                with self.lock:
                    if generation==self.generations.get(session,0):self.results[session]=(at,result)
                self.timings.update(scbActionMs=round((time.perf_counter()-started)*1000,2),scbDetections=len(detections));self.error=None
            except Exception as error:self.error=str(error)
            finally:self.busy=False
    def snapshot(self,session,identity,now):
        with self.lock:result=self.results.get(session)
        if result and 0<=now-result[0]<=2500 and not self.error and identity in result[1]:return [dict(a) for a in result[1][identity]]
        return [dict(type=kind,label=label,state='unavailable',source=self.model_name,observedAt=now,
            reason=self.error or (self.status if self.status!='ready' else 'waiting_for_current_person')) for kind,label in zip(KINDS,LABELS)]
    def release(self,session):
        with self.lock:
            self.generations[session]=self.generations.get(session,0)+1
            for store in (self.latest,self.results,self.submitted):store.pop(session,None)
    def close(self):
        self.stop.set()
        if self.thread:self.thread.join(timeout=10)
        self.detector=None
