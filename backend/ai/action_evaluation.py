"""Person-box multi-label scoring; missing/unknown evidence counts as missed GT."""
from collections import Counter
from scipy.optimize import linear_sum_assignment
import numpy as np

def overlap(a,b):
    left,top=max(a['x'],b['x']),max(a['y'],b['y'])
    area=max(0,min(a['x']+a['width'],b['x']+b['width'])-left)*max(0,min(a['y']+a['height'],b['y']+b['height'])-top)
    return area/max(1e-9,a['width']*a['height']+b['width']*b['height']-area)

def score_frame(ground,tracks,at,labels):
    counts={label:Counter(tp=0,fp=0,fn=0,gt=0,unknown=0,decided=0) for label in labels}
    tracks=[t for t in tracks if t.get('status')=='visible' and t.get('personBox')]
    # Exclude sub-threshold pairs before assignment. Filtering only afterwards
    # can discard a valid pair in favor of two high-but-invalid overlaps.
    costs=np.full((len(ground),len(tracks)),len(ground)+len(tracks)+1.,np.float64)
    for gi,g in enumerate(ground):
        for pi,p in enumerate(tracks):
            value=overlap(g['box'],p['personBox'])
            if value>=.5:costs[gi,pi]=1-value
    matches={}
    if costs.size:
        rows,cols=linear_sum_assignment(costs)
        matches={int(gi):int(pi) for gi,pi in zip(rows,cols) if costs[gi,pi]<=.5}
    def states(track):
        result={}
        for action in track.get('actions',[]):
            fresh=0<=at-action.get('observedAt',-100000)<=2500
            result[action['type']]=action['state'] if fresh else 'unavailable'
        for signal in track.get('signals',[]):result[signal['type']]=signal['state']
        return result
    for gi,g in enumerate(ground):
        predicted=states(tracks[matches[gi]]) if gi in matches else {}
        truth=set(g['labels'])
        for label in labels:
            state=predicted.get(label,'unavailable');positive=state=='confirmed'
            if label in truth:
                counts[label]['gt']+=1;counts[label]['tp' if positive else 'fn']+=1
                counts[label]['unknown' if state not in ('clear','confirmed') else 'decided']+=1
            elif positive:counts[label]['fp']+=1
    for pi,p in enumerate(tracks):
        if pi not in matches.values():
            for label,state in states(p).items():
                if label in counts and state=='confirmed':counts[label]['fp']+=1
    return counts

def summarize(counts):
    result={}
    for label,row in counts.items():
        p=row['tp']/(row['tp']+row['fp']) if row['tp']+row['fp'] else 0
        r=row['tp']/(row['tp']+row['fn']) if row['tp']+row['fn'] else 0
        f1=2*p*r/(p+r) if p+r else 0
        result[label]={**row,'precisionPct':100*p,'recallPct':100*r,'f1Pct':100*f1,
            'decisionCoveragePct':100*row['decided']/row['gt'] if row['gt'] else None,
            'passed':row['gt']>0 and f1>=.85 and row['decided']/row['gt']>=.85}
    return dict(labels=result,passed=bool(result) and all(r['passed'] for r in result.values()),
        macroF1Pct=sum(r['f1Pct'] for r in result.values())/len(result) if result else None)
