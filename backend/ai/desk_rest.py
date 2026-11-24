"""A conservative appearance cue for folded heads that have no pose landmarks."""
import hashlib,json
from pathlib import Path
import cv2,numpy as np
from geometry import iou
from scb_detection import prepare_image


def latest_rest_evidence(history,at):
    """Use a completed cue for this image or an earlier, still-fresh image.

    The auxiliary worker can finish a newer image while person detection is
    running. Its result must not mask the appropriate older completed result.
    """
    return max(((stamp,cues) for stamp,cues in history if 0<=at-stamp<=1500),
               key=lambda item:item[0],default=(0,[]))


def decode_rest(prediction,transform):
    rows=np.asarray(prediction)[0].T
    if rows.ndim!=2 or rows.shape[1]!=11:raise ValueError('Unexpected auxiliary model layout')
    scores=rows[:,5]  # class 1: Sleeping, used only as an observed posture cue
    other=np.max(np.concatenate([rows[:,4:5],rows[:,6:]],axis=1),axis=1)
    indices=np.flatnonzero(((scores>=.25)&(scores-other>=.05))|((scores>=.17)&(scores-other>=.12)))
    boxes=rows[indices,:4].copy();boxes[:,:2]-=boxes[:,2:]/2
    kept=cv2.dnn.NMSBoxes(boxes.tolist(),scores[indices].tolist(),.17,.45)
    width,height,scale,left,top=transform;output=[]
    for kept_index in np.asarray(kept,dtype=int).reshape(-1):
        index=indices[kept_index];x,y,w,h=boxes[kept_index]
        x1=max(0.,(x-left)/scale);y1=max(0.,(y-top)/scale)
        x2=min(float(width),(x+w-left)/scale);y2=min(float(height),(y+h-top)/scale)
        if x2>x1 and y2>y1:output.append(dict(box=[x1/width,y1/height,(x2-x1)/width,(y2-y1)/height],confidence=float(scores[index])))
    return output


def _cue_samples(old,cue,cue_at,at):
    samples=list(old.get('cueSamples',[(old.get('cueAt'),old.get('cueConfidence',0))])) if old else []
    samples=[(stamp,confidence) for stamp,confidence in samples if stamp is not None and 0<=at-stamp<=2000 and confidence>=.35]
    if cue_at is not None and 0<=at-cue_at<=1500 and cue['confidence']>=.35 and not any(stamp==cue_at for stamp,_ in samples):
        samples.append((cue_at,cue['confidence']))
    return sorted(samples)[-8:]


def _rest_support(box,cue,previous,at,cue_at,allow_pending=False):
    support=[]
    for old in previous:
        if not 300<=at-old['personObservedAt']<=2000:continue
        region=old.get('supportBox',old['box'])
        if iou(old['box'],region)<.35:continue
        if iou(box,region)<.35:continue
        if old.get('confirmed'):
            # A known body uses the specialist detector's normal positive
            # threshold. Starting a new body still needs strong, repeated
            # agreement; a temporary score dip must not reset that identity.
            if cue['confidence']>=.25 and iou(cue['box'],region)>=.5:support.append(old)
        elif (cue_at is not None and 0<=at-cue_at<=1500 and cue['confidence']>=.35 and iou(cue['box'],region)>=.65):
            # The second person hit may cover only shoulders as the head folds.
            # Use two strong specialist images or three consistent positives
            # with a strong anchor; all remain actual, distinct source images.
            samples=_cue_samples(old,cue,cue_at,at)
            strong_pair=old.get('cueAt')!=cue_at and cue['confidence']>=.5 and old.get('cueConfidence',0)>=.5
            sustained=len(samples)>=3 and samples[-1][0]-samples[0][0]>=600 and max(confidence for _,confidence in samples)>=.5
            if allow_pending or strong_pair or sustained:support.append(old)
    return support


def rest_person_candidates(rows,evidence,width,height,at,cue_at,previous=()):
    """Independent weak person + strong posture evidence for the next scan.

    This records actual detections only; it does not create boxes or renew a
    confidence score. Two distinct image/auxiliary-model times are required.
    """
    output=[]
    for cue in evidence:
        if cue['confidence']<.25:continue
        if cue['confidence']<.35 and not any(p.get('confirmed') and
                0<=at-p['personObservedAt']<=2000 and iou(p.get('supportBox',p['box']),cue['box'])>=.5 for p in previous):continue
        candidates=[]
        for row in rows:
            x1,y1,x2,y2=row[:4];w,h=x2-x1,y2-y1
            if row[5]!=0 or row[4]<.03 or h<=0:continue
            box=[x1/width,y1/height,w/width,h/height];score=iou(box,cue['box'])
            support=_rest_support(box,cue,previous,at,cue_at,allow_pending=True)
            repeated=bool(len(support)==1 and score>=.35)
            confirmed=bool(repeated and support[0].get('confirmed'))
            if w/h<1.1 and not repeated:continue
            region=tuple(support[0].get('supportBox',support[0]['box'])) if confirmed else None
            if score>=(.35 if repeated else .65):candidates.append((score,box,float(row[4]),confirmed,region,support[0] if repeated else None))
        candidates.sort(key=lambda item:-item[0])
        same_person=len(candidates)>1 and candidates[0][3] and candidates[1][3] and candidates[0][4]==candidates[1][4]
        if candidates and (len(candidates)==1 or candidates[0][0]-candidates[1][0]>=.05 or same_person):
            _,box,confidence,confirmed,_,prior=candidates[0]
            output.append(dict(box=box,supportBox=list(cue['box']),personConfidence=confidence,personObservedAt=at,
                cueAt=cue_at,cueConfidence=cue['confidence'],confirmed=confirmed,cueSamples=_cue_samples(prior,cue,cue_at,at)))
        else:
            # An absent or ambiguous primary detection must not erase the
            # short identity history. Auxiliary evidence alone never renews
            # its body timestamp or publishes a person rectangle.
            for old in previous:
                if 0<=at-old['personObservedAt']<=2000 and iou(old.get('supportBox',old['box']),cue['box'])>=(.5 if old.get('confirmed') else .65):
                    output.append(dict(old,cueAt=cue_at,cueConfidence=cue['confidence'],cueSamples=_cue_samples(old,cue,cue_at,at)))
    # A negative auxiliary image cannot erase the identity's short history.
    # Keep its original evidence times; this history alone never draws a body.
    for old in previous:
        if 0<=at-old['personObservedAt']<=2000 and not any(
                iou(old.get('supportBox',old['box']),new.get('supportBox',new['box']))>=.5 for new in output):
            output.append(dict(old))
    return output


def corroborate_people(rows,evidence,width,height,at=0,recent=(),persistent=(),cue_at=None):
    result=np.asarray(rows).copy();matched={};used=set()
    for cue in sorted(evidence,key=lambda item:item['confidence'],reverse=True):
        candidates=[]
        for index,row in enumerate(result):
            if index in used or row[5]!=0 or row[4]<.03:continue
            x1,y1,x2,y2=row[:4];w,h=x2-x1,y2-y1
            if h<=0:continue
            box=[x1/width,y1/height,w/width,h/height];score=iou(box,cue['box'])
            support=_rest_support(box,cue,persistent,at,cue_at)
            repeated=bool(len(support)==1 and score>=.35)
            continuing=bool(repeated and support[0].get('confirmed'))
            # New people still require horizontal-body agreement. A previously
            # corroborated person can change body extent while folding down.
            if w/h<1.1 and not repeated:continue
            reference=None;temporal=False
            if row[4]<.1:
                references=sorted([(iou(box,p['box']),p) for p in recent
                    if 0<=at-p['personObservedAt']<=2000 and p['personConfidence']>=.1],
                    key=lambda item:item[0],reverse=True)
                if references and references[0][0]>=.5 and (len(references)==1 or references[0][0]-references[1][0]>=.05):
                    reference=references[0][1]
                else:
                    # An already folded person can be weak from the FIRST
                    # frame. Repeated agreement of two models can start its
                    # body track; the original weak person score is preserved
                    # and cannot independently confirm a posture alert.
                    if not repeated:continue
                    temporal=True
            region=tuple(support[0].get('supportBox',support[0]['box'])) if continuing else None
            if score>=(.35 if repeated else .45):candidates.append((score,index,box,reference,temporal,region))
        candidates.sort(reverse=True)
        same_person=len(candidates)>1 and candidates[0][5] is not None and candidates[0][5]==candidates[1][5]
        if not candidates or len(candidates)>1 and candidates[0][0]-candidates[1][0]<.05 and not same_person:continue
        _,index,box,reference,temporal,region=candidates[0];used.add(index)
        continuing=region is not None
        matched[index]=dict(active=True,confidence=cue['confidence'],candidateConfidence=float(result[index,4]),
            personConfidence=reference['personConfidence'] if reference else float(result[index,4]),
            personObservedAt=reference['personObservedAt'] if reference else at,candidateBox=box,box=box,
            postureBox=list(cue['box']),temporalPerson=temporal or continuing)
        if temporal or continuing:
            # The specialist model supplies the folded-body extent after the
            # person has been independently corroborated. A small COCO head/
            # shoulder candidate cannot repeatedly shrink away that body box.
            x,y,w,h=cue['box'];result[index,:4]=[x*width,y*height,(x+w)*width,(y+h)*height]
            matched[index]['box']=list(cue['box'])
        # Only the agreement of two models can rescue a weak person candidate.
        result[index,4]=max(result[index,4],min(.6,cue['confidence']))
    return result,matched


def activate_confirmed_rest_people(tracker,tracked,matched,width,height,scale):
    """Temporal two-model confirmation already supplies the second hit.

    ByteTrack normally hides a newly born track until the next person hit; a
    folded target could disappear again before that hit. Publish only an actual
    current ByteTrack rectangle matched to independently confirmed evidence.
    """
    cues=[cue for cue in matched.values() if cue.get('temporalPerson')]
    if not cues:return tracked
    additions=[];published={int(row[4]) for row in tracked}
    for track in tracker.tracked_stracks:
        if track.is_activated or track.track_id in published:continue
        row=np.asarray(track.result,dtype=float);row[:4]/=scale
        box=[row[0]/width,row[1]/height,(row[2]-row[0])/width,(row[3]-row[1])/height]
        if any(iou(box,cue['box'])>=.5 for cue in cues):
            track.is_activated=True;additions.append(row)
    if not additions:return tracked
    return np.concatenate([tracked,np.asarray(additions)],axis=0) if tracked.size else np.asarray(additions)


def attach_rest(tracked,rows,matched,at,width,height):
    output={}
    for track in tracked:
        box=[track[0]/width,track[1]/height,(track[2]-track[0])/width,(track[3]-track[1])/height]
        candidates=[(iou(box,cue['box']),index,cue) for index,cue in matched.items() if iou(box,cue['box'])>=.5]
        candidates.sort(key=lambda value:value[0],reverse=True)
        if candidates and (len(candidates)==1 or candidates[0][0]-candidates[1][0]>=.05):
            cue=candidates[0][2];output[int(track[4])]={**cue,'observedAt':at,'source':'classroom-appearance + YOLO11s'}
    return output


def _containment(a,b):
    ax,ay,aw,ah=a;bx,by,bw,bh=b
    inter=max(0.,min(ax+aw,bx+bw)-max(ax,bx))*max(0.,min(ay+ah,by+bh)-max(ay,by))
    smallest=min(aw*ah,bw*bh)
    return inter/smallest if smallest>0 else 0.


def match_rest_to_bodies(bodies,observations,evidence,cue_at,at):
    """Link fresh DeskRest posture cues directly to Tier-1 YOLO+ByteTrack bodies.

    Creates new corroborated rest entries when a slumped-on-desk cue agrees with
    a live person rectangle, and clears active=False when the student sits up.
    """
    if not cue_at or not 0<=at-cue_at<=1800:return {}
    output={}
    for body in bodies:
        old=observations.get(body['id'])
        if old:
            output[body['id']]={**old,'active':False,'confidence':0,'observedAt':cue_at}
    used=set()
    for cue in sorted(evidence,key=lambda item:item['confidence'],reverse=True):
        if cue['confidence']<.17:continue
        candidates=[]
        for body in bodies:
            identity=body['id']
            if identity in used:continue
            if cue['confidence']<.25 and identity not in observations:continue
            ov=iou(body['box'],cue['box'])
            ct=_containment(body['box'],cue['box'])
            if ov>=.25 or (ct>=.60 and ov>=.10):
                candidates.append((ov+.35*ct,identity,body))
        candidates.sort(key=lambda item:(-item[0], 0 if item[1] in observations else 1))
        if not candidates:continue
        if len(candidates)>1 and candidates[0][0]-candidates[1][0]<.05:
            # Allow tie-break only when two boxes overlap heavily (duplicate YOLO box on the same person).
            if iou(candidates[0][2]['box'],candidates[1][2]['box'])<.55:
                continue
        _,identity,body=candidates[0];used.add(identity)
        old=observations.get(identity,{})
        raw_conf=float(body.get('confidence',.5))
        conf=max(.1,raw_conf)
        body_at=body.get('seen',body.get('at'))
        live_person=body_at is not None and raw_conf>=.1 and not body.get('temporalPerson')
        person_at=body_at if live_person else old.get('personObservedAt',at)
        output[identity]={
            **old,
            'active':True,
            'confidence':float(cue['confidence']),
            'personConfidence':conf if live_person else old.get('personConfidence',conf),
            'candidateConfidence':conf,
            'personObservedAt':person_at,
            'box':list(cue['box']),
            'postureBox':list(cue['box']),
            'observedAt':cue_at,
            'source':'classroom-appearance + YOLO11n',
        }
    return output


def refresh_rest(bodies,observations,evidence,cue_at,at):
    """Publish fresh posture evidence independently of a slow person scan.

    This only updates metadata of an existing corroborated body. It never
    creates a rectangle or renews the independent person's source timestamp.
    """
    if not cue_at or not 0<=at-cue_at<=1500:return {}
    known={}
    for body in bodies:
        old=observations.get(body['id'])
        if not old:continue
        person_at=old.get('personObservedAt',old['observedAt'])
        if not 0<=at-person_at<=2000:continue
        if old.get('personConfidence',0)<.1 and not old.get('temporalPerson'):continue
        known[body['id']]=(body,old)
    output={identity:{**old,'active':False,'confidence':0,'observedAt':cue_at}
            for identity,(_,old) in known.items()}
    used=set()
    for cue in sorted(evidence,key=lambda item:item['confidence'],reverse=True):
        if cue['confidence']<.25:continue
        candidates=sorted([(iou(body['box'],cue['box']),identity,old) for identity,(body,old) in known.items()
                           if identity not in used and iou(body['box'],cue['box'])>=.5],key=lambda item:-item[0])
        if not candidates or len(candidates)>1 and candidates[0][0]-candidates[1][0]<.05:continue
        _,identity,old=candidates[0];used.add(identity)
        output[identity]={**old,'active':True,'confidence':cue['confidence'],'box':list(cue['box']),'observedAt':cue_at}
    return output


class DeskRestDetector:
    def __init__(self,directory):
        import onnxruntime as ort
        directory=Path(directory);spec=json.loads(Path(__file__).with_name('desk_rest_model.json').read_text())
        report=json.loads((directory/'desk-rest-verification.json').read_text())
        graph=directory/'desk_rest.onnx'
        if not report.get('prepared') or report.get('checkpointSha256')!=spec['checkpointSha256'] or hashlib.sha256(graph.read_bytes()).hexdigest()!=report['onnxSha256']:
            raise RuntimeError('Prepare the pinned desk-rest model with npm run setup:ai')
        options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
        options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
        options.add_session_config_entry('session.intra_op.allow_spinning','0')
        self.session=ort.InferenceSession(str(graph),sess_options=options,providers=['CPUExecutionProvider'])
    def predict(self,frame):
        image,transform=prepare_image(frame)
        return decode_rest(self.session.run(None,{'images':image})[0],transform)
