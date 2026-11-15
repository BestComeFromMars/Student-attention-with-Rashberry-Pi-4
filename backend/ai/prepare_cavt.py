"""Drop optimizer/training metadata; preserve every learned tensor exactly."""
import sys
from pathlib import Path
import numpy as np
import torch

root=Path(sys.argv[1])
safe=[np.core.multiarray.scalar,np.dtype,type(np.dtype(np.float64)),type(np.dtype(np.float32)),type(np.dtype(np.int64))]
with torch.serialization.safe_globals(safe):
    payload=torch.load(root/'cavt_daisee.pth',map_location='cpu',weights_only=True,mmap=True)
state=payload['state_dict']
assert len(state)==232
target=root/'cavt_daisee_weights.pt'
temporary=target.with_suffix('.part')
torch.save({'state_dict':state},temporary)
temporary.replace(target)
print('CavT inference weights extracted: '+str(target.stat().st_size)+' bytes',flush=True)
