"""SAV's published cut offsets, with real preceding frames for causal warmup."""
import math
from pathlib import Path

WARMUP_SECONDS=3.0

def sav_source(directory,clip):
    directory=Path(directory)
    original,index=clip.rsplit('_',1)
    # Author's cut_videos.sh: (required_index - 1) * 2 + 1.5, duration 3s.
    origin=max(0.,(int(index)-1)*2+1.5)
    full=directory/(original+'.mp4')
    if full.is_file():
        start=max(0.,origin-WARMUP_SECONDS)
        return dict(path=str(full.resolve()),sourceStartSeconds=start,sourceEndSeconds=origin+3,
            annotationOriginSeconds=origin,preRollSeconds=origin-start,
            causalWarmupAvailable=origin-start>=WARMUP_SECONDS)
    return dict(path=str((directory/(clip+'.mp4')).resolve()),sourceStartSeconds=0.,sourceEndSeconds=3.,
        annotationOriginSeconds=0.,preRollSeconds=0.,causalWarmupAvailable=False)

def source_frame(start,tick,output_fps,source_fps):
    # Never round to a frame from the future when resampling the source clock.
    return math.floor((start+tick/output_fps)*source_fps+1e-9)
