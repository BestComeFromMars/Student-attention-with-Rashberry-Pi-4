"""Continuity of rendered IDs over completed realtime AI decisions."""


def replay_stability(recording):
    rows=[row for row in recording['requests'] if row.get('status')==200 and row.get('end',float('inf'))<=recording['endedAt']]
    timeline={kind:[] for kind in ('people','faces','objects')}
    for row in rows:
        tracks=[track for track in row['data']['tracks'] if track.get('status')=='visible']
        timeline['people'].append({track['id'] for track in tracks if track.get('personBox')})
        timeline['faces'].append({track['id'] for track in tracks if track.get('faceVisibility')!='unavailable' and
            track.get('trackingState')!='predicted' and (track.get('faceBox') or track.get('boxKind')=='face')})
        timeline['objects'].append({obj['id'] for obj in row['data'].get('objects',[])})
    result={}
    for kind,samples in timeline.items():
        identities=sorted(set().union(*samples)) if samples else []
        details=[]
        first_nonempty=next((index for index,ids in enumerate(samples) if ids),None)
        blank=[]
        for index,ids in enumerate(samples):
            if first_nonempty is not None and index>=first_nonempty and not ids:
                end=rows[index+1]['end'] if index+1<len(rows) else recording['endedAt']
                blank.append(max(0,end-rows[index]['end']))
        for identity in identities:
            seen=[index for index,ids in enumerate(samples) if identity in ids]
            gaps=[]
            for before,after in zip(seen,seen[1:]):
                if after>before+1:
                    gaps.append(dict(startSeconds=(rows[before+1]['end']-recording['startedAt'])/1000,
                        seconds=(rows[after]['end']-rows[before+1]['end'])/1000))
            details.append(dict(id=identity,responsesPresent=len(seen),responsesFromFirstToLast=seen[-1]-seen[0]+1,
                firstAtSeconds=(rows[seen[0]]['end']-recording['startedAt'])/1000,
                lastAtSeconds=(rows[seen[-1]]['end']-recording['startedAt'])/1000,
                interruptions=gaps))
        result[kind]=dict(firstAtSeconds=(rows[first_nonempty]['end']-recording['startedAt'])/1000 if first_nonempty is not None else None,
            minimumAfterFirst=min((len(ids) for ids in samples[first_nonempty:]),default=0) if first_nonempty is not None else 0,
            maximum=max(map(len,samples),default=0),emptyResponsesAfterFirst=len(blank),totalEmptySecondsAfterFirst=sum(blank)/1000,
            IDsWithInterruptions=sum(bool(item['interruptions']) for item in details),
            longestIDInterruptionSeconds=max((gap['seconds'] for item in details for gap in item['interruptions']),default=0),
            IDs=details)
    return result
