"""Download the pinned official SCB artifacts only inside this repository."""
import collections,hashlib,json,sys,tarfile,urllib.request,urllib.parse,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];sys.path.insert(0,str(ROOT/'backend/ai'))
from http_range_zip import HTTPRangeZip

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def read(url):
    return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'StudentAttention academic classroom evaluation'}),timeout=60)

def main():
    spec=json.loads((ROOT/'backend/ai/scb_model.json').read_text());directory=ROOT/'backend/models/classroom-actions';directory.mkdir(parents=True,exist_ok=True)
    base='https://huggingface.co/datasets/'+spec['datasetRepository']+'/resolve/'+spec['revision']+'/'
    checkpoint=directory/'scb5_read_write_yolov7.pt'
    if not checkpoint.is_file() or digest(checkpoint)!=spec['sha256']:
        partial=checkpoint.with_suffix('.pt.part');size=0;sha=hashlib.sha256()
        with read(base+spec['checkpoint']+'?download=true') as response,partial.open('wb') as stream:
            for block in iter(lambda:response.read(1024*1024),b''):stream.write(block);sha.update(block);size+=len(block)
        if size!=spec['bytes'] or sha.hexdigest()!=spec['sha256']:raise RuntimeError('SCB checkpoint checksum mismatch')
        partial.replace(checkpoint)
    vendor=ROOT/'backend/ai/vendor/yolov7';marker=vendor/'source.json';valid=False
    if marker.is_file():
        info=json.loads(marker.read_text());valid=info.get('commit')==spec['architectureCommit'] and all((vendor/name).is_file() and digest(vendor/name)==sha for name,sha in info.get('files',{}).items())
    if not valid:
        vendor.mkdir(parents=True,exist_ok=True);hashes={}
        with read('https://codeload.github.com/WongKinYiu/yolov7/tar.gz/'+spec['architectureCommit']) as response,tarfile.open(fileobj=response,mode='r|gz') as archive:
            for member in archive:
                parts=Path(member.name).parts[1:]
                if not member.isfile() or not parts or '..' in parts:continue
                relative=Path(*parts)
                if (parts[0] in ('models','utils') and relative.suffix=='.py') or relative.as_posix() in ('LICENSE.md','README.md','requirements.txt'):
                    content=archive.extractfile(member).read();target=vendor/relative;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content);hashes[relative.as_posix()]=hashlib.sha256(content).hexdigest()
        marker.write_text(json.dumps(dict(repository=spec['architectureRepository'],commit=spec['architectureCommit'],files=hashes),indent=2))
    dataset=ROOT/'backend/tests/datasets/scb5_read_write';dataset.mkdir(parents=True,exist_ok=True);manifest=dataset/'manifest.json'
    if manifest.is_file():
        info=json.loads(manifest.read_text())
        if info.get('revision')!=spec['revision'] or len(info.get('samples',[]))!=32:raise RuntimeError('Unexpected frozen SCB sample')
        for row in info['samples']:
            for kind in ('image','label'):
                if digest(dataset/row[kind])!=row[kind+'Sha256']:raise RuntimeError('Frozen SCB sample changed')
    else:
        url=base+spec['archive']+'?download=true';source=HTTPRangeZip(url,max_bytes=64*1024*1024);records=[];counts=collections.Counter()
        with zipfile.ZipFile(source) as archive:
            names=set(archive.namelist());images=sorted(name for name in names if '/images/val/' in name and name.lower().endswith(('.jpg','.png','.jpeg')))
            if len(images)<32:raise RuntimeError('Not enough official validation images')
            for name in images[:32]:
                label_name=Path(name.replace('/images/','/labels/')).with_suffix('.txt').as_posix()
                image,label=archive.read(name),archive.read(label_name);record={}
                for kind,content,filename in [('image',image,Path(name).name),('label',label,Path(label_name).name)]:
                    target=dataset/(kind+'s')/filename;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(content)
                    record[kind]=target.relative_to(dataset).as_posix();record[kind+'Sha256']=hashlib.sha256(content).hexdigest()
                records.append(record);counts.update(int(line.split()[0]) for line in label.decode().splitlines() if line.strip())
        manifest.write_text(json.dumps(dict(dataset='Official SCB5 hand-raising/read/write subset',source=url,revision=spec['revision'],split='original validation',
            sampleRule='First 32 validation filenames in lexicographic order, frozen before model inference',totalOriginalValidationImages=len(images),
            classes=spec['classes'],classCounts=dict(counts),samples=records,scope='Only these validation images; not SCB3 six-class accuracy.'),indent=2))
    (directory/'scb-source.json').write_text(json.dumps(spec,indent=2));print('SCB checkpoint, architecture and 32 frozen validation images verified inside '+str(ROOT),flush=True)

if __name__=='__main__':main()
