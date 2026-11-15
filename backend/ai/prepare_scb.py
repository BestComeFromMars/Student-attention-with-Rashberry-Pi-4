"""Export the author's three-class SCB YOLOv7 checkpoint; never train it."""
import codecs,hashlib,json,sys,gc
from pathlib import Path
import numpy as np
import torch
from torch import nn

ROOT=Path(__file__).resolve().parents[2]
VENDOR=Path(__file__).parent/'vendor/yolov7'
sys.path.insert(0,str(VENDOR))

def main():
    from models.yolo import Model,Detect
    from models.common import Concat,Conv,MP,RepConv,SPPCSPC
    directory=ROOT/'backend/models/classroom-actions'
    checkpoint=directory/'scb5_read_write_yolov7.pt'
    expected='1f93f151286b21c89338fb8e229b218c5b1d061cc7361c042aca6d416a415857'
    if hashlib.sha256(checkpoint.read_bytes()).hexdigest()!=expected:raise RuntimeError('Unverified official SCB checkpoint')
    # Only allow the inspected tensor/module classes, not arbitrary pickle
    # globals or an unrestricted checkpoint loader.
    allowed=[set,codecs.encode,Model,Detect,Concat,Conv,MP,RepConv,SPPCSPC,np.ndarray,np.dtype,np.core.multiarray._reconstruct,
        np.dtypes.Float16DType,np.dtypes.Float32DType,np.dtypes.Float64DType,
        nn.SiLU,nn.BatchNorm2d,nn.ModuleList,nn.Sequential,nn.Conv2d,nn.MaxPool2d,nn.Upsample]
    with torch.serialization.safe_globals(allowed):saved=torch.load(checkpoint,map_location='cpu',weights_only=True)
    model=(saved.get('ema') or saved['model']).float().eval().requires_grad_(False)
    del saved;gc.collect()
    names=list(model.names.values()) if isinstance(model.names,dict) else list(model.names)
    if names!=['hand-raising','read','write']:raise RuntimeError('This is not the expected SCB three-class checkpoint: '+str(names))
    for module in model.modules():
        if isinstance(module,nn.Upsample) and not hasattr(module,'recompute_scale_factor'):module.recompute_scale_factor=None
    class Graph(nn.Module):
        def __init__(self,network):super().__init__();self.network=network
        def forward(self,image):return self.network(image)[0]
    torch.set_num_threads(1);torch.set_num_interop_threads(1)
    network=Graph(model).eval();torch.manual_seed(42);example=torch.rand(1,3,640,640)
    with torch.inference_mode():network(example)
    target=directory/'scb5_read_write_yolov7.onnx'
    # Export graph and tensors separately to avoid duplicating all model
    # weights in the Windows ONNX protobuf exporter at its memory peak.
    graph_path=directory/'scb5_read_write_graph.onnx'
    torch.onnx.export(network,example,str(graph_path),input_names=['images'],output_names=['predictions'],
        opset_version=17,do_constant_folding=False,export_params=False)
    import onnx
    graph=onnx.load(graph_path,load_external_data=False);state=network.state_dict();parameters={}
    data_path=directory/'scb5_read_write_yolov7.data';offset=0
    with data_path.open('wb') as stream:
        for value in list(graph.graph.input)[1:]:
            if value.name not in state:raise RuntimeError('Unknown exported checkpoint tensor '+value.name)
            tensor=state[value.name].detach().cpu().numpy();parameters[value.name]=True
            # A single tensor is serialized at a time, outside the graph heap.
            raw=tensor.tobytes();stream.write(raw)
            initializer=onnx.TensorProto(name=value.name,data_type=onnx.helper.np_dtype_to_tensor_dtype(tensor.dtype),dims=tensor.shape)
            initializer.data_location=onnx.TensorProto.EXTERNAL
            for key,text in [('location',data_path.name),('offset',str(offset)),('length',str(len(raw)))]:
                entry=initializer.external_data.add();entry.key=key;entry.value=text
            graph.graph.initializer.append(initializer);offset+=len(raw)
    real_inputs=[value for value in graph.graph.input if value.name not in parameters]
    del graph.graph.input[:];graph.graph.input.extend(real_inputs);onnx.save_model(graph,str(target))
    onnx.checker.check_model(str(target));del graph,state;gc.collect()
    # Verification runs in a separate ORT-only process after Torch exits.
    samples={}
    import cv2
    image_path=next((ROOT/'backend/tests/datasets/scb5_read_write/images').glob('*'))
    image=cv2.imread(str(image_path));height,width=image.shape[:2];scale=min(640/width,640/height)
    nw,nh=round(width*scale),round(height*scale);left,top=(640-nw)//2,(640-nh)//2
    pixels=np.full((640,640,3),114,np.uint8);pixels[top:top+nh,left:left+nw]=cv2.resize(image,(nw,nh))
    real=torch.from_numpy(np.ascontiguousarray(pixels[:,:,::-1].transpose(2,0,1)[None])).float()/255
    for i,sample in enumerate((example*0,example,real)):
        with torch.inference_mode():reference=network(sample).numpy()
        samples['input_'+str(i)]=sample.numpy();samples['output_'+str(i)]=reference
    output=ROOT/'.qa/action-demo/scb';output.mkdir(parents=True,exist_ok=True)
    np.savez(output/'equivalence-inputs.npz',**samples)
    report=dict(prepared=False,defaultEnabled=False,model='Official SCB YOLOv7',classes=names,classesCount=3,
        isSCB3SixClassCheckpoint=False,trainedLocally=False,checkpointSha256=expected,
        onnxSha256=hashlib.sha256(target.read_bytes()).hexdigest(),dataSha256=hashlib.sha256(data_path.read_bytes()).hexdigest(),
        inputShape=[1,3,640,640],parameters=sum(parameter.numel() for parameter in model.parameters()),
        outputShape=list(reference.shape),providers=['CPUExecutionProvider'],accuracyVerified=False)
    (directory/'scb-verification.json').write_text(json.dumps(report,indent=2),encoding='utf-8');print(json.dumps(report,indent=2))

if __name__=='__main__':main()
