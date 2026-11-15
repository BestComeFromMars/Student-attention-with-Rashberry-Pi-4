"""Checkpoint-compatible upstream CavT inference without the training MMCV runtime."""
import ast
import json
import threading
import subprocess
import sys
import base64
from collections import deque
from pathlib import Path
import cv2
import numpy as np
import torch
from torch import nn
from native_runtime import TORCH_LOCK,export_serialized


def load_backbone_class():
    path = Path(__file__).parent / "vendor" / "cait_transformer.py"
    module = ast.parse(path.read_text(encoding="utf8"))
    module.body = [node for node in module.body if not (isinstance(node, ast.ImportFrom) and node.level > 0)]
    for node in module.body:
        if isinstance(node, ast.ClassDef):
            node.decorator_list = []
    scope = {}
    exec(compile(ast.fix_missing_locations(module), str(path), "exec"), scope)
    return scope["Cait3D"]


class Head(nn.Module):
    def __init__(self):
        super().__init__()
        self.layernorm = nn.LayerNorm(1024)
        self.relu = nn.ReLU()
        self.dropout = nn.Dropout(.1)
        self.fc_cls = nn.Linear(1024, 1)
    def forward(self, features):
        return self.fc_cls(self.dropout(self.relu(features.reshape(features.shape[0], -1))))


class CavT(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = load_backbone_class()(
            video_size=(8, 112, 112), patch_size=(2, 14, 14), dim=1024, depth=12,
            cls_depth=2, heads=16, mlp_dim=2048, dropout=.1, emb_dropout=.1, layer_dropout=0.)
        self.cls_head = Head()
    @export_serialized
    def forward(self, images):
        return self.cls_head(self.backbone(images))


def int8_structure(module):
    """Build quantized layers directly, without materializing float Linear weights."""
    for name,child in list(module.named_children()):
        if isinstance(child,nn.Linear):
            setattr(module,name,torch.ao.nn.quantized.dynamic.Linear(
                child.in_features,child.out_features,bias_=child.bias is not None,dtype=torch.qint8))
        else:
            int8_structure(child)


class LocalEngagement:
    def __init__(self, models, device, prepare_int8=False, start_thread=True):
        self.model = None
        self.device = device
        self.frames = {}
        self.latest = {}
        self.scores = {}
        self.submitted = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        cached = device=='cpu' and not prepare_int8
        checkpoint = Path(models) / ("cavt_daisee_int8.pt" if cached else "cavt_daisee_weights.pt")
        self.status = "missing_checkpoint"
        if checkpoint.exists():
            # The author's training metadata contains NumPy numeric scalars.
            # Keep the restricted weights loader; allow only their numeric dtype constructors.
            safe = [np.core.multiarray.scalar,np.dtype,
                    type(np.dtype(np.float64)),type(np.dtype(np.float32)),type(np.dtype(np.int64))]
            with torch.serialization.safe_globals(safe):
                payload = torch.load(checkpoint,map_location="cpu",weights_only=True,mmap=True)
            state = payload.get("state_dict", payload)
            with torch.device("meta"):
                model = CavT()
            if cached:
                # Preserve OrderedDict metadata: quantized packed parameters use it.
                int8_structure(model)
                model.to_empty(device='cpu')
                model.load_state_dict(state,strict=True)
            else:
                state = {key.removeprefix("module."): value for key, value in state.items()}
                model.load_state_dict(state, strict=True, assign=True)
            self.model = model.eval().requires_grad_(False).to(device)
            if device=='cpu':
                if prepare_int8:
                    self.model=torch.ao.quantization.quantize_dynamic(
                        self.model,{nn.Linear},dtype=torch.qint8,inplace=True)
                for module in self.model.modules():
                    if isinstance(module,torch.ao.nn.quantized.dynamic.Linear):
                        bias=module.bias()
                        module.set_weight_bias(module.weight().clone(),None if bias is None else bias.detach().clone())
                for parameter in self.model.parameters():
                    parameter.data=parameter.detach().clone()
            self.status = "ready"
            if start_thread:
                self.start()
    def start(self):
        if self.model is not None and self.thread is None:
            self.thread = threading.Thread(target=self._loop, name="cavt-scores", daemon=False)
            self.thread.start()
    def observe(self, key, face, now_ms):
        with self.lock:
            frames = self.frames.setdefault(key, deque(maxlen=8))
            if not frames or now_ms - frames[-1][0] >= 180:
                rgb = cv2.cvtColor(cv2.resize(face, (112, 112)), cv2.COLOR_BGR2RGB)
                frames.append((now_ms, rgb))
            if len(frames) == 8 and self.model is not None and now_ms-self.submitted.get(key,0)>5000:
                self.latest[key] = (np.stack([entry[1] for entry in frames]),now_ms)
                self.submitted[key] = now_ms
            score = self.scores.get(key)
            return score[0] if score and now_ms-score[1]<15000 else None
    def _loop(self):
        while not self.stop.wait(.05):
            if hasattr(self,'priority') and not self.priority():continue
            with self.lock:
                if not self.latest:
                    continue
                key = next(iter(self.latest))
                images,at = self.latest.pop(key)
            images = images.astype(np.float32)
            images = (images - np.array([102.21,77.74,72.60],np.float32))/np.array([52.,40.49,42.07],np.float32)
            tensor = torch.from_numpy(images.transpose(3,0,1,2).copy()).unsqueeze(0).to(self.device)
            try:
                with TORCH_LOCK, torch.inference_mode():
                    score = float(self.model(tensor).reshape(-1)[0].item())
                with self.lock:
                    if key in self.frames:
                        self.scores[key] = (score,at)
            except Exception:
                import traceback
                traceback.print_exc()
    def release(self, session):
        with self.lock:
            for storage in (self.frames,self.latest,self.scores,self.submitted):
                for key in list(storage):
                    if key[0] == session:
                        del storage[key]
    def retain(self,session,identities):
        with self.lock:
            for storage in (self.frames,self.latest,self.scores,self.submitted):
                for key in list(storage):
                    if key[0]==session and key[1] not in identities:
                        del storage[key]
    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=10)


class Engagement(LocalEngagement):
    """Isolate the large Torch transformer from MediaPipe's native CPU delegates."""
    def __init__(self,models,device):
        self.device=device
        self.frames,self.latest,self.scores,self.submitted={},{},{},{}
        self.lock=threading.Lock()
        self.stop=threading.Event()
        self.child=subprocess.Popen([sys.executable,'-X','faulthandler','-u',str(Path(__file__).with_name('cavt_worker.py')),
            '--models',str(models),'--device',device],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
            stderr=sys.stderr,text=True,creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0)
        line=self.child.stdout.readline()
        if not line:
            code=self.child.wait()
            raise RuntimeError('CavT failed to start (code '+str(code)+'). Run npm run setup:ai in backend.')
        ready=json.loads(line)
        if ready.get('type')!='ready':
            raise RuntimeError('CavT child did not load its verified checkpoint')
        self.model=True
        self.status='ready'
        self.thread=threading.Thread(target=self._loop,name='cavt-ipc',daemon=False)
        self.thread.start()

    def _loop(self):
        while not self.stop.wait(.05):
            with self.lock:
                if not self.latest:
                    continue
                key=next(iter(self.latest))
                images,at=self.latest.pop(key)
            try:
                self.child.stdin.write(json.dumps({'images':base64.b64encode(images.tobytes()).decode('ascii')})+'\n')
                self.child.stdin.flush()
                line=self.child.stdout.readline()
                if not line:
                    raise RuntimeError('CavT process exited with '+str(self.child.wait()))
                response=json.loads(line)
                score=float(response['score'])
                if not np.isfinite(score):
                    raise ValueError('CavT returned a non-finite score')
                with self.lock:
                    if key in self.frames:
                        self.scores[key]=(score,at)
            except Exception:
                self.status='error'
                import traceback
                traceback.print_exc()
                return

    def close(self):
        self.stop.set()
        self.thread.join(timeout=5)
        try:
            self.child.stdin.close()
            self.child.wait(timeout=5)
        except (OSError,subprocess.TimeoutExpired):
            self.child.kill()
            self.child.wait()
