"""Score only source annotations, including every missed/unknown GT instance."""
from collections import Counter
import json
from pathlib import Path
from action_evaluation import score_frame,summarize
ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'.qa/action-demo'
REQUIRED_SCENARIOS={'face_hidden_slump','face_return','same_position_different_person',
    'object_between_people','camera_source_change','turn_face','smile','reading_head_down'}

def timing(values):
    values=sorted(values)
    return dict(samples=len(values),medianMs=values[len(values)//2] if values else None,
        p95Ms=values[int((len(values)-1)*.95)] if values else None,maxMs=values[-1] if values else None)

def main():
    manifest=json.loads((WORK/'demo-manifest.json').read_text(encoding='utf-8'));results=[]
    labels=json.loads(Path(__file__).with_name('action_labels.json').read_text(encoding='utf-8'))
    for video in manifest['videos']:
        required=[label['type'] for label in labels[:15]] if video['dataset']=='SAV' else ['eyes_closed','phone','head_down','yawn','talking','laptop','slumped_on_desk']
        total={key:Counter(tp=0,fp=0,fn=0,gt=0,unknown=0,decided=0) for key in required};frames=0
        with (WORK/(video['name']+'_predictions.jsonl')).open(encoding='utf-8') as stream:
            for line in stream:
                prediction=json.loads(line);frames+=1;ground=video['groundTruth'].get(str(prediction['frame']))
                if ground is not None:
                    rows=score_frame(ground,prediction['tracks'],prediction['evaluatedAt'],required)
                    for key,row in rows.items():total[key].update(row)
        if frames!=video['frames']:raise RuntimeError('Incomplete demo output')
        events=json.loads((WORK/(video['name']+'_events.json')).read_text(encoding='utf-8'))
        ages={label:[] for label in required};seen=set()
        for event in events:
            for person in event.get('tracks',[]):
                for action in person.get('actions',[]):
                    identity=(person['id'],action['type'],action['observedAt'])
                    if action['type'] in ages and action['state']=='confirmed' and identity not in seen and 'availableAt' in event:
                        seen.add(identity);ages[action['type']].append(event['availableAt']-action['observedAt'])
        results.append(dict(video=video['name'],frames=frames,**summarize(total),
            apiResponseLatency=timing([e['latencyMs'] for e in events if 'latencyMs' in e]),
            evidenceAgeAtDelivery={label:timing(values) for label,values in ages.items()},
            actionOnsetLatencyMs=None,actionOnsetLatencyReason='SAV keyframe labels do not establish independently annotated action-onset times. Delivery latency and evidence age are reported separately.'))
    covered={scenario for video in manifest['videos'] for segment in video['segments'] for scenario in segment.get('scenarios',[])}
    missing_scenarios=sorted(REQUIRED_SCENARIOS-covered)
    missing_labels={result['video']:[label for label,row in result['labels'].items() if row['gt']==0] for result in results}
    report=dict(complete=True,passed=all(result['passed'] for result in results),scope='Only these two videos, not general SAV accuracy.',
        accuracyVerified=True,videos=results,missingScenarios=missing_scenarios,labelsWithoutSamples=missing_labels)
    if missing_scenarios or any(missing_labels.values()):report.update(complete=False,passed=False)
    (WORK/'assessment.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8');print(json.dumps(report,indent=2))

if __name__=='__main__':main()
