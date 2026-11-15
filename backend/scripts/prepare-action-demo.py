"""Freeze SAV label coverage before inference and resolve real source files.

Missing media is a hard failure. Labels, still images and another dataset must
never be substituted for SAV video or used as model predictions.
"""
import argparse
from collections import defaultdict,Counter
import csv,hashlib,json,re
from pathlib import Path
import subprocess,sys
from concurrent.futures import ThreadPoolExecutor

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend/ai'))
from demo_sources import sav_source
def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):digest.update(block)
    return digest.hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--source-dir',type=Path,default=ROOT/'.qa/action-demo/sav_sources')
    parser.add_argument('--probe-public',action='store_true');args=parser.parse_args()
    work=ROOT/'.qa/action-demo';work.mkdir(parents=True,exist_ok=True)
    labels_path=work/'sav_val.csv';clips=defaultdict(set);instances=Counter();rows=0
    with labels_path.open(encoding='utf-8-sig',newline='') as stream:
        for row in csv.reader(stream):
            label=int(row[6]);rows+=1
            if not 1<=label<=15:raise ValueError('Unexpected SAV action id')
            clips[row[0]].add(label);instances[label]+=1
    # Deterministic coverage selection, independent from model output.
    selected=[];coverage=Counter();remaining=set(clips)
    while any(coverage[label]<5 for label in range(1,16)):
        choice=min(remaining,key=lambda name:(-sum(1/(1+coverage[c]) for c in clips[name] if coverage[c]<5),name))
        useful=[c for c in clips[choice] if coverage[c]<5]
        if not useful:raise RuntimeError('Cannot cover all 15 SAV labels')
        selected.append(choice);remaining.remove(choice);coverage.update(clips[choice])
    records=[]
    for name in selected:
        source=sav_source(args.source_dir,name);path=Path(source['path'])
        records.append(dict(clip=name,labels=sorted(clips[name]),**source,available=path.is_file(),
            sha256=sha(path) if path.is_file() else None,dataset='SAV'))
    report=dict(source='https://github.com/Ritatanz/SAV',selectionFrozenBeforeInference=True,
        labelsSha256=sha(labels_path),annotationRows=rows,availableClips=len(clips),selectedClips=records,
        selectedCoverage={str(c):coverage[c] for c in range(1,16)},
        ready=all(row['available'] and row['causalWarmupAvailable'] for row in records),accuracyVerified=False,
        reason='Missing original SAV video or preceding warmup frames. Do not create placeholder MP4s.' if any(not row['available'] or not row['causalWarmupAvailable'] for row in records) else None)
    if args.probe_public:
        urls=re.findall(r'https?://\S+',(work/'source_links.txt').read_text(encoding='utf-8'))
        samples=[urls[0],urls[len(urls)//2],urls[-1]]
        def probe(url):
            result=subprocess.run([sys.executable,'-m','yt_dlp','--skip-download','--dump-json','--socket-timeout','10','--retries','0',url],
                capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=45,creationflags=subprocess.CREATE_NO_WINDOW if sys.platform=='win32' else 0)
            return dict(url=url,available=result.returncode==0,diagnostic=result.stderr[-1800:])
        with ThreadPoolExecutor(max_workers=3) as pool:report['publicSourceChecks']=list(pool.map(probe,samples))
    elif (work/'sav-selection.json').is_file():
        previous=json.loads((work/'sav-selection.json').read_text(encoding='utf-8'))
        if 'publicSourceChecks' in previous:report['publicSourceChecks']=previous['publicSourceChecks']
    target=work/'sav-selection.json';target.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('selectedClips',)},ensure_ascii=False,indent=2),flush=True)
    if not report['ready']:raise SystemExit(2)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
