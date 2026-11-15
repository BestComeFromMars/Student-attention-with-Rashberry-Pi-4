"""Continue an identified folded person using current specialist detections."""
from geometry import iou


class RestBodyTracking:
    def __init__(self):self.tracks={}

    def seed(self,bodies,observations,at):
        for body in bodies:
            cue=observations.get(body['id'])
            if not cue or not cue.get('active') or not 0<=at-cue['observedAt']<=1500:continue
            person_at=cue.get('personObservedAt',cue['observedAt'])
            if not 0<=at-person_at<=2000:continue
            if cue['personConfidence']<.1 and not (cue.get('temporalPerson') and cue.get('candidateConfidence',0)>=.03):continue
            box=cue.get('postureBox',cue['box']);identity=body['id']
            candidates=sorted([(iou(box,old['box']),key) for key,old in self.tracks.items()
                if abs(at-old['at'])<=2000 and iou(box,old['box'])>=.7],reverse=True)
            if candidates and (len(candidates)==1 or candidates[0][0]-candidates[1][0]>=.05):identity=candidates[0][1]
            old=self.tracks.get(identity)
            if old:
                if person_at>=old['evidence'].get('personObservedAt',0):old['evidence']=dict(cue)
                if cue['observedAt']>=old['checkedAt']:
                    old.update(box=list(box),at=cue['observedAt'],checkedAt=cue['observedAt'],confidence=cue['confidence'],active=True)
            else:
                self.tracks[identity]=dict(box=list(box),at=cue['observedAt'],checkedAt=cue['observedAt'],
                    confirmedAt=at,confidence=cue['confidence'],active=True,evidence=dict(cue))

    def update(self,evidence,at):
        self.tracks={identity:old for identity,old in self.tracks.items() if at-old['at']<=2000}
        available={identity:old for identity,old in self.tracks.items() if at>=old['checkedAt']}
        for old in available.values():old.update(active=False,checkedAt=at)
        used=set()
        for cue in sorted(evidence,key=lambda item:item['confidence'],reverse=True):
            if cue['confidence']<.25:continue
            candidates=sorted([(iou(old['box'],cue['box']),identity) for identity,old in available.items()
                if identity not in used and iou(old['box'],cue['box'])>=.5],reverse=True)
            if not candidates or len(candidates)>1 and candidates[0][0]-candidates[1][0]<.05:continue
            _,identity=candidates[0];used.add(identity)
            available[identity].update(box=list(cue['box']),at=at,checkedAt=at,confidence=cue['confidence'],active=True)

    def snapshot(self,at):
        output=[]
        for identity,old in self.tracks.items():
            if not 0<=at-old['at']<=1500:continue
            rest={**old['evidence'],'active':old['active'],'confidence':old['confidence'] if old['active'] else 0,
                'observedAt':old['checkedAt'],'box':list(old['box']),'trackedBodyAt':old['at'],'personConfirmedAt':old['confirmedAt']}
            output.append(dict(id=identity,at=old['at'],seen=old['at'],box=list(old['box']),
                confidence=old['confidence'],observation=dict(deskRest=rest)))
        return output
