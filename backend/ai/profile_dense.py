"""Offline fixed-input CPU workspace comparison, no model/threshold changes."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import time,json,gc
import cv2,numpy as np,onnxruntime as ort,torch,psutil
from onnx_yolo import ONNXRuntimeYOLO
from scrfd import SCRFD

root=Path(__file__).resolve().parents[1];out=root.parent/'.qa/dense-profile';out.mkdir(parents=True,exist_ok=True)
cv2.setNumThreads(1);torch.set_num_threads(1)
image=cv2.imread(str(root.parent/'.qa/class_3-realtime-after/actual_uploads/000001.jpg'))
report=[];references={}
for arena in (False,True):
    models=[]
    for name,pose in [('yolo11s',False),('yolo11m',False),('yolo11n-pose',True)]:
        model=ONNXRuntimeYOLO(root/'models/classroom'/f'{name}.onnx',pose=pose)
        if arena:
            options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
            options.enable_cpu_mem_arena=True;options.enable_mem_pattern=True
            options.add_session_config_entry('session.intra_op.allow_spinning','0')
            model.net.session=ort.InferenceSession(str(root/'models/classroom'/f'{name}.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
        model.predict(image,conf=.25)
        models.append((name,model))
    sequential=[]
    for name,model in models:
        times=[]
        for _ in range(3):
            before=time.perf_counter();result=model.predict(image,conf=.25)[0]
            times.append((time.perf_counter()-before)*1000)
        boxes=result.boxes.data.numpy()
        if not arena:references[name]=boxes.copy()
        else:np.testing.assert_allclose(boxes,references[name],atol=1e-4,rtol=1e-5)
        sequential.append(dict(model=name,medianMs=round(float(np.median(times)),1),boxes=len(boxes)))
    def run(pair):
        name,model=pair;before=time.perf_counter();model.predict(image,conf=.25)
        return dict(model=name,ms=round((time.perf_counter()-before)*1000,1))
    start=time.perf_counter()
    with ThreadPoolExecutor(max_workers=3) as pool:concurrent=list(pool.map(run,models))
    row=dict(arena=arena,sequential=sequential,concurrent=concurrent,concurrentWallMs=round((time.perf_counter()-start)*1000,1),
        privateMemoryMB=round(getattr(psutil.Process().memory_info(),'private',psutil.Process().memory_info().rss)/1024**2,1))
    report.append(row);print(json.dumps(row),flush=True)
    del models,model;gc.collect()
(out/'cpu.json').write_text(json.dumps(report,indent=2),encoding='utf8')
