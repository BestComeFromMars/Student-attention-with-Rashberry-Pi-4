"""Measure the actual production ONNX artifact without the preparation stack."""
import argparse,json,time,threading
from pathlib import Path
import numpy as np
import onnxruntime as ort
import psutil

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--threads',type=int,default=2);args=parser.parse_args()
    directory=Path(__file__).resolve().parents[1]/'models/actions';process=psutil.Process();peak=[0];stop=threading.Event()
    def sample():
        while not stop.wait(.005):peak[0]=max(peak[0],process.memory_info().private/2**20)
    thread=threading.Thread(target=sample);thread.start()
    baseline=process.memory_info().private/2**20
    options=ort.SessionOptions();options.intra_op_num_threads=args.threads;options.inter_op_num_threads=1
    options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
    session=ort.InferenceSession(str(directory/'mobileviclip_tiny.onnx'),sess_options=options,providers=['CPUExecutionProvider'])
    rng=np.random.default_rng(42);video=rng.random((1,3,8,256,256),dtype=np.float32);times=[]
    for _ in range(8):
        started=time.perf_counter();session.run(None,{'video':video});times.append((time.perf_counter()-started)*1000)
    stop.set();thread.join()
    report=dict(threads=args.threads,baselinePrivateMB=baseline,peakPrivateMB=peak[0],extraPrivateMB=peak[0]-baseline,inferenceMs=times,
        medianMs=float(np.median(times)),p95Ms=float(np.percentile(times,95)),maxPeopleAt2sCadence=int(2000/np.median(times)),
        note='Capacity estimate for actions alone; six-cue and tracking work also needs CPU time.')
    path=directory/('runtime-'+str(args.threads)+'.json');path.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))

if __name__=='__main__':main()
