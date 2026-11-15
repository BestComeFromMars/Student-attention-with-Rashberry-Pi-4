"""Score the frozen validation sample without training or changing thresholds."""
from collections import Counter
import hashlib,json,threading,time
from pathlib import Path
import cv2
import numpy as np
import psutil
from scipy.optimize import linear_sum_assignment
from scb_detection import CLASSES,SCBDetector
from geometry import iou

ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'.qa/action-demo/scb'

def match_counts(ground,predictions,label):
    truth=[box for cls,box in ground if cls==label];predicted=[p['box'] for p in predictions if p['classId']==label]
    cost=np.full((len(truth),len(predicted)),len(truth)+len(predicted)+1.)
    for gi,g in enumerate(truth):
        for pi,p in enumerate(predicted):
            overlap=iou(g,p)
            if overlap>=.5:cost[gi,pi]=1-overlap
    tp=0
    if cost.size:
        rows,cols=linear_sum_assignment(cost);tp=int(sum(cost[g,p]<=.5 for g,p in zip(rows,cols)))
    return Counter(tp=tp,fp=len(predicted)-tp,fn=len(truth)-tp,gt=len(truth))

def main():
    dataset=ROOT/'backend/tests/datasets/scb5_read_write';manifest=json.loads((dataset/'manifest.json').read_text())
    process=psutil.Process();peak=[0];stop=threading.Event()
    def measure():
        while not stop.wait(.01):peak[0]=max(peak[0],process.memory_info().private/2**20)
    thread=threading.Thread(target=measure);thread.start()
    totals={label:Counter() for label in range(3)};predictions=[];times=[]
    try:
        model=SCBDetector(ROOT/'backend/models/classroom-actions')
        for index,sample in enumerate(manifest['samples']):
            for key in ('image','label'):
                if hashlib.sha256((dataset/sample[key]).read_bytes()).hexdigest()!=sample[key+'Sha256']:raise RuntimeError('Frozen validation sample changed')
            frame=cv2.imread(str(dataset/sample['image']));ground=[]
            for line in (dataset/sample['label']).read_text().splitlines():
                if not line.strip():continue
                cls,cx,cy,w,h=map(float,line.split());ground.append((int(cls),[cx-w/2,cy-h/2,w,h]))
            started=time.perf_counter();result=model.predict(frame);times.append((time.perf_counter()-started)*1000)
            for label in range(3):totals[label].update(match_counts(ground,result,label))
            predictions.append(dict(image=sample['image'],predictions=result))
            if index%8==0:print('SCB validation '+str(index+1)+'/'+str(len(manifest['samples'])),flush=True)
    finally:stop.set();thread.join()
    rows={}
    for label,count in totals.items():
        p=count['tp']/max(1,count['tp']+count['fp']);r=count['tp']/max(1,count['tp']+count['fn']);f=2*p*r/(p+r) if p+r else 0
        rows[CLASSES[label]]=dict(count,precisionPct=p*100,recallPct=r*100,f1Pct=f*100,passed=bool(count['gt']) and f>=.85)
    report=dict(dataset=manifest['dataset'],split=manifest['split'],sampleRule=manifest['sampleRule'],images=len(predictions),
        classes=rows,confidenceThreshold=.25,nmsIoU=.45,matchingIoU=.5,oneToOneMatching=True,
        passed=all(row['passed'] for row in rows.values()),requestedSixClassBenchmarkPassed=False,
        scope='Only the 32 frozen SCB validation still images. Not video/temporal performance, not full six SCB3 classes or fifteen SAV classes.',
        trainedLocally=False,medianMs=float(np.median(times)),p95Ms=float(np.percentile(times,95)),peakPrivateMB=peak[0])
    (WORK/'validation-predictions.json').write_text(json.dumps(predictions,ensure_ascii=False),encoding='utf-8')
    (WORK/'validation.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report,indent=2),flush=True)

if __name__=='__main__':main()
