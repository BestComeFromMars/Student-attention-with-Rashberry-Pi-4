"""Prepare the exact CPU quantized state once, before other AI models occupy RAM."""
import gc
import sys
from pathlib import Path
import torch
from cavt import LocalEngagement

torch.set_num_threads(1)
torch.set_num_interop_threads(1)
root=Path(sys.argv[1])
engine=LocalEngagement(root,'cpu',prepare_int8=True)
engine.close()
gc.collect()
if engine.model is None:
    raise RuntimeError('Missing CavT source checkpoint')
target=root/'cavt_daisee_int8.pt'
temporary=target.with_suffix('.part')
torch.save({'state_dict':engine.model.state_dict(),'recipe':'dynamic-int8-v1'},temporary)
temporary.replace(target)
print('CavT CPU INT8 cache prepared: '+str(target.stat().st_size)+' bytes',flush=True)
