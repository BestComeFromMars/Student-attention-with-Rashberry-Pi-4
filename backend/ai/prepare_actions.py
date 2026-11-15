"""Export verified MobileViCLIP inference only, with no training dependencies.

The author checkpoint uses DeepSpeed's `module` key and omits the frozen text
encoder. That encoder is read from Apple's base checkpoint, once, to prepare
the fixed prompt vectors. Runtime never loads a text encoder or PyTorch here.
"""
import argparse
import ast
import copy
import hashlib
import json
import logging
import math
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from typing import List,Tuple,Optional,Union,Sequence,Dict
import numpy as np
import torch
from torch import nn,Tensor,Size
import torch.nn.functional as F
import torch.utils.checkpoint as checkpoint
from torchvision.ops import StochasticDepth
from timm.layers import DropPath,trunc_normal_,SqueezeExcite
from timm.data import IMAGENET_DEFAULT_MEAN,IMAGENET_DEFAULT_STD

ROOT=Path(__file__).resolve().parents[2]
VENDOR=Path(__file__).parent/'vendor/mobileviclip'
BASE='models/backbones/internvideo2/mobileclip/'

def definitions(relative,dependencies=None):
    path=VENDOR/relative
    tree=ast.parse(path.read_text(encoding='utf-8'))
    # Remove optional CUDA/training imports; keep all original class/function
    # bodies and parameters, as with the existing CavT inference adapter.
    tree.body=[node for node in tree.body if isinstance(node,(ast.ClassDef,ast.FunctionDef,ast.Assign,ast.AnnAssign))]
    for node in tree.body:
        if isinstance(node,(ast.ClassDef,ast.FunctionDef)):node.decorator_list=[]
    scope=dict(globals());scope.update(dependencies or {})
    exec(compile(ast.fix_missing_locations(tree),str(path),'exec'),scope)
    return scope

def models(directory):
    specification=json.loads(Path(__file__).with_name('action_model.json').read_text())
    for expected in specification['files']:
        path=directory/expected['path'];digest=hashlib.sha256()
        with path.open('rb') as stream:
            for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
        if path.stat().st_size!=expected['bytes'] or digest.hexdigest()!=expected['sha256']:raise ValueError('Unverified action checkpoint: '+path.name)
    one=definitions(BASE+'modules/common/mobileone.py')
    large=definitions(BASE+'modules/image/replknet.py')
    position=definitions('models/backbones/internvideo2/pos_embed.py')
    scope=definitions('models/mobileviclip_tiny.py',dict(MobileOneBlock=one['MobileOneBlock'],MobileOneBlock_1d=one['MobileOneBlock_1d'],
        ReparamLargeKernelConv=large['ReparamLargeKernelConv'],get_1d_sincos_pos_embed=position['get_1d_sincos_pos_embed']))
    config=SimpleNamespace(model=SimpleNamespace(vision_encoder=SimpleNamespace(clip_embed_dim=512,attn_pool_num_heads=16,head_drop_path_rate=0.)))
    vision=scope['MobileViCLIP_Tiny'].build_vision_encoder(SimpleNamespace(config=config))
    with torch.serialization.safe_globals([set]):saved=torch.load(directory/'mobileviclip_tiny.pt',map_location='cpu',weights_only=True,mmap=True)
    state=saved['module'];vision.load_state_dict({k.removeprefix('vision_encoder.'):v for k,v in state.items() if k.startswith('vision_encoder.')},strict=True)
    # DeepSpeed omits frozen text parameters, but keeps the trained text
    # projection and updated normalization buffers. Match the author's order:
    # load the Apple base, then overlay every saved MobileViCLIP text tensor.
    text_overlay={k.removeprefix('text_encoder.'):v for k,v in state.items() if k.startswith('text_encoder.')}
    if 'projection_layer' not in text_overlay:raise ValueError('Missing trained MobileViCLIP text projection')
    del saved,state
    transformer=definitions(BASE+'transformer.py')
    rep=definitions(BASE+'modules/text/repmixer.py',dict(MobileOneBlock=one['MobileOneBlock']))
    text_scope=definitions(BASE+'text_encoder.py',{**{k:transformer[k] for k in ('PositionalEmbedding','TransformerEncoder','get_normalization_layer')},'RepMixerBlock':rep['RepMixerBlock']})
    cfg=json.loads((VENDOR/'apple/mobileclip/configs/mobileclip_s0.json').read_text())
    text=text_scope['TextTransformer'](cfg['text_cfg'],512)
    base=torch.load(directory/'mobileclip_s0.pt',map_location='cpu',weights_only=True,mmap=True)
    text_state={k.removeprefix('text_encoder.'):v for k,v in base.items() if k.startswith('text_encoder.')}
    text_state.update(text_overlay)
    text.load_state_dict(text_state,strict=True)
    if not torch.equal(text.projection_layer,text_overlay['projection_layer'].to(text.projection_layer.dtype)):
        raise RuntimeError('Trained text projection did not load exactly')
    text._checkpoint_overlay_keys=sorted(text_overlay)
    return vision.eval().requires_grad_(False),text.eval().requires_grad_(False),cfg

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--models',type=Path,default=ROOT/'backend/models/actions');args=parser.parse_args()
    torch.set_num_threads(1);torch.set_num_interop_threads(1)
    directory=args.models;directory.mkdir(parents=True,exist_ok=True)
    labels=json.loads((Path(__file__).with_name('action_labels.json')).read_text(encoding='utf-8'))
    vision,text,cfg=models(directory)
    for module in vision.modules():
        if hasattr(module,'with_cp'):module.with_cp=False
    import open_clip
    tokenizer=open_clip.get_tokenizer('ViT-B-16',context_length=cfg['text_cfg']['context_length'])
    prompts=[sentence for item in labels for sentence in (item['positive'],item['negative'])]
    with torch.inference_mode():
        vectors=[]
        for prompt in prompts:
            feature=text(tokenizer([prompt]));vectors.append(F.normalize(feature,dim=-1)[0].numpy())
        vectors=np.stack(vectors);np.save(directory/'action_text.npy',vectors)
    text_overlay_keys=text._checkpoint_overlay_keys
    text_projection_sha=hashlib.sha256(text.projection_layer.detach().cpu().numpy().tobytes()).hexdigest()
    del text
    # Reference includes real transformed pixels and a nonzero deterministic
    # tensor, rather than testing equivalence only on an all-black frame.
    torch.manual_seed(42);example=torch.rand((1,3,8,256,256))
    with torch.inference_mode():unfused_reference=vision(example).numpy()
    one=definitions(BASE+'modules/common/mobileone.py')
    vision=one['reparameterize_model'](vision).eval()
    with torch.inference_mode():fused_reference=vision(example).numpy()
    fusion_error=float(np.max(np.abs(unfused_reference-fused_reference)))
    if fusion_error>1e-3:raise RuntimeError('Official branch fusion changed model output')
    target=directory/'mobileviclip_tiny.onnx'
    torch.onnx.export(vision,example,str(target),input_names=['video'],output_names=['embedding'],opset_version=17,do_constant_folding=True)
    import onnxruntime as ort
    options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
    options.enable_cpu_mem_arena=False;options.enable_mem_pattern=False
    session=ort.InferenceSession(str(target),sess_options=options,providers=['CPUExecutionProvider'])
    errors=[];times=[]
    import time,psutil
    for _ in range(5):
        with torch.inference_mode():reference=vision(example).numpy()
        started=time.perf_counter();actual=session.run(None,{'video':example.numpy()})[0];times.append((time.perf_counter()-started)*1000)
        errors.append(float(np.max(np.abs(reference-actual))))
        example=example*.9+.01
    hash_file=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
    report=dict(ready=max(errors)<1e-3,model='MobileViCLIP-Tiny',classes=15,extraPostures=1,fusionMaxAbsoluteError=fusion_error,
        maxAbsoluteError=max(errors),inferenceMs=times,privateMB=psutil.Process().memory_info().private/2**20,
        labelSha256=hash_file(Path(__file__).with_name('action_labels.json')),
        files={p.name:hash_file(p) for p in (target,directory/'action_text.npy')},
        precision='float32',trainedTextOverlayApplied=True,textOverlayKeys=text_overlay_keys,
        textProjectionSha256=text_projection_sha,
        trainedOnSAV=False,accuracyVerified=False)
    (directory/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report,indent=2),flush=True)
    if not report['ready']:raise RuntimeError('ONNX equivalence failed; action model remains disabled')

if __name__=='__main__':main()
