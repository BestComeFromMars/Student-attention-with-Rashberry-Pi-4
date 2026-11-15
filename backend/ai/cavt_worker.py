"""Private stdin worker, exits when its parent closes the pipe; no listeners or camera."""
import argparse
import base64
import json
import sys
import gc
import numpy as np
import torch
from cavt import LocalEngagement


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--models',required=True)
    parser.add_argument('--device',default='cpu')
    args=parser.parse_args()
    torch.set_num_threads(1)
    torch.set_num_interop_threads(1)
    torch.backends.mkldnn.enabled=False
    engine=LocalEngagement(args.models,args.device)
    engine.stop.set()
    if engine.thread:
        engine.thread.join()
    # Quantization leaves cyclic observer/module references until a full GC.
    # Collect them before loading the browser alongside this process.
    gc.collect()
    if engine.model is None:
        raise RuntimeError('Missing CavT checkpoint')
    print(json.dumps({'type':'ready'}),flush=True)
    try:
        for line in sys.stdin:
            data=json.loads(line)
            images=np.frombuffer(base64.b64decode(data['images'],validate=True),np.uint8).reshape(8,112,112,3)
            images=(images.astype(np.float32)-np.array([102.21,77.74,72.60],np.float32))/np.array([52.,40.49,42.07],np.float32)
            tensor=torch.from_numpy(images.transpose(3,0,1,2).copy()).unsqueeze(0).to(args.device)
            with torch.inference_mode():
                score=float(engine.model(tensor).reshape(-1)[0].item())
            print(json.dumps({'score':score},allow_nan=False),flush=True)
    finally:
        engine.close()


if __name__=='__main__':
    main()
