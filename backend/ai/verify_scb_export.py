"""Verify exported SCB graph without retaining the Torch preparation stack."""
import hashlib,json,time
from pathlib import Path
import numpy as np
import onnxruntime as ort
import psutil

ROOT=Path(__file__).resolve().parents[2]

def main():
    directory=ROOT/'backend/models/classroom-actions';path=directory/'scb-verification.json'
    report=json.loads(path.read_text());report['prepared']=False;path.write_text(json.dumps(report,indent=2))
    for filename,key in [('scb5_read_write_yolov7.onnx','onnxSha256'),('scb5_read_write_yolov7.data','dataSha256')]:
        if hashlib.sha256((directory/filename).read_bytes()).hexdigest()!=report[key]:raise RuntimeError('Unverified export '+filename)
    options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
    options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
    options.add_session_config_entry('session.intra_op.allow_spinning','0')
    session=ort.InferenceSession(str(directory/'scb5_read_write_yolov7.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
    references=np.load(ROOT/'.qa/action-demo/scb/equivalence-inputs.npz',allow_pickle=False);errors=[];times=[]
    for i in range(3):
        started=time.perf_counter();result=session.run(None,{'images':references['input_'+str(i)]})[0];times.append((time.perf_counter()-started)*1000)
        expected=references['output_'+str(i)];errors.append(float(np.max(np.abs(expected-result))))
        if not np.allclose(expected,result,rtol=.001,atol=.001):raise RuntimeError('SCB numerical equivalence failed')
    report.update(prepared=True,maxAbsoluteError=max(errors),equivalenceSamples=3,inferenceMs=times,
        privateMB=psutil.Process().memory_info().private/2**20)
    path.write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report,indent=2))

if __name__=='__main__':main()
