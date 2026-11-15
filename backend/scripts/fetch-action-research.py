"""Fetch author-published research artifacts; never install the training stack."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import zipfile
import gdown

ROOT=Path(__file__).resolve().parents[2]
def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'StudentAttention-research'}),timeout=90) as response:
        return response.read()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--weights',action='store_true');parser.add_argument('--data',action='store_true')
    args=parser.parse_args();work=ROOT/'.qa/action-demo';work.mkdir(parents=True,exist_ok=True)
    if args.weights:
        specification=json.loads((ROOT/'backend/ai/action_model.json').read_text())
        upstream=specification['commit']
        target=ROOT/'backend/ai/vendor/mobileviclip';target.mkdir(parents=True,exist_ok=True)
        archive=zipfile.ZipFile(io.BytesIO(fetch(f'https://codeload.github.com/MCG-NJU/MobileViCLIP/zip/{upstream}')))
        hashes={}
        for member in archive.infolist():
            relative=Path(*Path(member.filename).parts[1:])
            if member.is_dir() or '..' in relative.parts:continue
            if str(relative)=='LICENSE' or str(relative)=='README.md' or relative.parts[0] in ('models','configs'):
                data=archive.read(member);path=target/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
                hashes[relative.as_posix()]=hashlib.sha256(data).hexdigest()
        (target/'source.json').write_text(json.dumps(dict(repository='https://github.com/MCG-NJU/MobileViCLIP',commit=upstream,files=hashes),indent=2))
        listing=gdown.download_folder('https://drive.google.com/drive/folders/1ROJYwQeO8lt4mEfNjEIAIDWj736WIQq7',skip_download=True,quiet=True,use_cookies=False)
        models=ROOT/'backend/models/actions';models.mkdir(parents=True,exist_ok=True)
        manifest=[]
        for item in listing:
            if item.path!='mobileviclip_tiny.pt':continue
            path=models/item.path
            part=path.with_suffix('.pt.part')
            if not path.exists():
                gdown.download(id=item.id,output=str(part),quiet=False,resume=True,use_cookies=False)
                part.replace(path)
            data=path.read_bytes();manifest.append(dict(path=path.name,driveId=item.id,bytes=len(data),sha256=hashlib.sha256(data).hexdigest()))
        (models/'upstream.json').write_text(json.dumps(dict(repository='https://github.com/MCG-NJU/MobileViCLIP',commit=upstream,files=manifest),indent=2))
        base=models/'mobileclip_s0.pt'
        if not base.exists():
            url='https://docs-assets.developer.apple.com/ml-research/datasets/mobileclip/mobileclip_s0.pt'
            with urllib.request.urlopen(url,timeout=90) as response,base.with_suffix('.pt.part').open('wb') as stream:
                while True:
                    chunk=response.read(1024*1024)
                    if not chunk:break
                    stream.write(chunk)
            base.with_suffix('.pt.part').replace(base)
        for expected in specification['files']:
            path=models/expected['path'];digest=hashlib.sha256()
            with path.open('rb') as stream:
                for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
            if path.stat().st_size!=expected['bytes'] or digest.hexdigest()!=expected['sha256']:raise RuntimeError('Action checkpoint checksum mismatch: '+path.name)
        apple=specification['appleCommit']
        for relative in ('mobileclip/configs/mobileclip_s0.json','LICENSE','LICENSE_MODELS'):
            data=fetch(f'https://raw.githubusercontent.com/apple-aiml-research/ml-mobileclip/{apple}/{relative}')
            path=target/'apple'/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
        (target/'apple/source.json').write_text(json.dumps(dict(repository='https://github.com/apple-aiml-research/ml-mobileclip',commit=apple)))
        print(json.dumps(manifest),flush=True)
    if args.data:
        entries={'source_links.txt':'1S4EONu-faoUxy8y_dIYIqM5LOfyTlGNP','clips_to_keep.txt':'1Z3x-farXpzLt7Q3nGSpq5sH_DzVCq-TD',
            'sav_labels.pbtxt':'1bRS5ia_9UUlBTRNuGvc8jBFv3lHLSseg','sav_val.csv':'1lfWBtmJ98cd0xWNqyq0Ax888ZmdZ0p4L',
            'sav_val_boxes.csv':'1tf2Fyu1Kl_k55kxsHeLWOlYiz3DLK0MQ','sav_val_frames.csv':'1fx7adqC6MiKdQdB3tlGVZkLEpYokUqOS'}
        for name,identity in entries.items():
            target=work/name
            if not target.exists():gdown.download(id=identity,output=str(target),quiet=True,use_cookies=False)
            print(name,target.stat().st_size,flush=True)

if __name__=='__main__':main()
