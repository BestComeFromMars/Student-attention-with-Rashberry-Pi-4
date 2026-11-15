"""Prepare a pinned auxiliary posture graph entirely inside the repository."""
import hashlib,json,shutil,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
SPEC=json.loads((ROOT/'backend/ai/desk_rest_model.json').read_text(encoding='utf-8'))
DIRECTORY=ROOT/'backend/models/classroom'

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    DIRECTORY.mkdir(parents=True,exist_ok=True)
    graph=DIRECTORY/'desk_rest.onnx';marker=DIRECTORY/'desk-rest-verification.json'
    if graph.exists() and marker.exists():
        report=json.loads(marker.read_text())
        if report.get('prepared') and report.get('cueVersion')=='person-shape-v1' and report.get('checkpointSha256')==SPEC['checkpointSha256'] and sha(graph)==report.get('onnxSha256'):
            print('Desk-rest auxiliary graph verified (repository-local).');return
    cache=ROOT/'.qa/action-demo/classroom-candidates/rukesh-classroom.onnx'
    if cache.is_file() and sha(cache)==SPEC['cachedOnnxSha256']:
        shutil.copyfile(cache,graph)
        source=json.loads(cache.with_name('verification.json').read_text())
        if not source.get('prepared') or source.get('equivalenceSamples')!=3:raise RuntimeError('Unverified cached graph')
        report=dict(source)
    else:
        temporary=ROOT/'backend/.cache/desk-rest';temporary.mkdir(parents=True,exist_ok=True)
        checkpoint=temporary/'behavior_yolo.pt'
        if not checkpoint.exists() or sha(checkpoint)!=SPEC['checkpointSha256']:
            partial=checkpoint.with_suffix('.pt.part')
            with urllib.request.urlopen(SPEC['checkpointUrl'],timeout=120) as response,partial.open('wb') as stream:
                shutil.copyfileobj(response,stream)
            if partial.stat().st_size!=SPEC['checkpointBytes'] or sha(partial)!=SPEC['checkpointSha256']:raise RuntimeError('Checkpoint checksum mismatch')
            partial.replace(checkpoint)
        import torch
        from torch import nn
        from ultralytics.nn.modules.block import Bottleneck,C2f,DFL,SPPF
        from ultralytics.nn.modules.conv import Concat,Conv
        from ultralytics.nn.modules.head import Detect
        from ultralytics.nn.tasks import DetectionModel
        from ultralytics.utils import IterableSimpleNamespace
        allowed=[set,DetectionModel,Detect,Bottleneck,C2f,DFL,SPPF,Concat,Conv,IterableSimpleNamespace,
            nn.SiLU,nn.BatchNorm2d,nn.ModuleList,nn.Sequential,nn.Conv2d,nn.Identity,nn.MaxPool2d,nn.Upsample]
        torch.set_num_threads(1);torch.set_num_interop_threads(1)
        with torch.serialization.safe_globals(allowed):saved=torch.load(checkpoint,map_location='cpu',weights_only=True)
        model=(saved.get('ema') or saved['model']).float().eval().requires_grad_(False)
        names=list(model.names.values()) if isinstance(model.names,dict) else list(model.names)
        if names!=SPEC['classes']:raise RuntimeError('Wrong checkpoint classes')
        head=model.model[-1];head.export=True;head.format='onnx';head.dynamic=False
        model.args=vars(model.args) if isinstance(model.args,IterableSimpleNamespace) else model.args
        example=torch.zeros(1,3,640,640)
        with torch.inference_mode():model(example)
        torch.onnx.export(model,example,str(graph),input_names=['images'],output_names=['predictions'],opset_version=17,do_constant_folding=True)
        import numpy as np,onnxruntime as ort
        options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
        session=ort.InferenceSession(str(graph),sess_options=options,providers=['CPUExecutionProvider'])
        for sample in (example,torch.ones_like(example),torch.rand_like(example)):
            with torch.inference_mode():expected=model(sample).numpy()
            actual=session.run(None,{'images':sample.numpy()})[0]
            if not np.allclose(expected,actual,rtol=.001,atol=.001):raise RuntimeError('ONNX equivalence failed')
        report=dict(prepared=True,classes=names,equivalenceSamples=3)
    report.update(prepared=True,checkpointSha256=SPEC['checkpointSha256'],onnxSha256=sha(graph),
        source=SPEC['repository'],revision=SPEC['revision'],activeClass='Sleeping',
        usage='Desk-rest posture, corroborated by independent person detection; no sleep diagnosis',
        accuracyVerified=False,trainedLocally=False,defaultEnabled=True,cueVersion='person-shape-v1')
    marker.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print('Desk-rest auxiliary graph prepared and verified inside '+str(DIRECTORY))

if __name__=='__main__':main()
