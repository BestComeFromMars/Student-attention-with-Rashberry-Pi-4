"""Score captured AI and causally displayed boxes after unattended playback.

CDED reference regions contain heads and shoulders, not full bodies, faces or
objects. Spatial association is coverage of those regions, never bbox AP or
behavior accuracy. Labels are read only here, after the real AI run has ended.
"""
import argparse
import csv
import json
from pathlib import Path

import numpy as np
from scipy.optimize import linear_sum_assignment
from replay_stability import replay_stability


def associate(ground, boxes, kind, width, height):
    costs = np.full((len(ground), len(boxes)), 1e6)
    for gi, region in enumerate(ground):
        x1, y1, x2, y2 = region
        for pi, box in enumerate(boxes):
            left, top = box['x'] * width, box['y'] * height
            right, bottom = left + box['width'] * width, top + box['height'] * height
            cx, cy = (left + right) / 2, (top + bottom) / 2
            if kind == 'faces':
                eligible = x1 <= cx <= x2 and y1 <= cy <= y2
            else:
                intersection = max(0, min(right, x2) - max(left, x1)) * max(0, min(bottom, y2) - max(top, y1))
                eligible = intersection >= .5 * max(1, (x2 - x1) * (y2 - y1))
            if eligible:
                costs[gi, pi] = ((cx - (x1 + x2) / 2) / max(1, x2 - x1)) ** 2 + ((cy - (y1 + y2) / 2) / max(1, y2 - y1)) ** 2
    if not costs.size:
        return 0
    rows, columns = linear_sum_assignment(costs)
    return sum(costs[gi, pi] < 1e5 for gi, pi in zip(rows, columns))


def boxes_for(data, displayed):
    people, faces = [], []
    for track in data.get('tracks', []):
        if track.get('status') != 'visible':
            continue
        presentation = track.get('displayBoxes', {}) if displayed else {}
        if track.get('personBox'):
            people.append(presentation.get('person', track['personBox']))
        face = track.get('faceBox') or (track['box'] if track.get('boxKind') == 'face' else None)
        if face and track.get('faceVisibility') != 'unavailable' and track.get('trackingState') != 'predicted':
            faces.append(presentation.get('face', face))
    return dict(people=people, faces=faces)


def evaluate(samples, references, info, displayed):
    totals = {kind: dict(referenceRegions=0, predictedBoxes=0, matchedRegions=0, annotatedSamples=0) for kind in ('people', 'faces')}
    details = []
    for frame, data in samples:
        ground = references.get(frame)
        if ground is None:
            continue
        boxes = boxes_for(data, displayed)
        detail = dict(frame=frame, referenceRegions=len(ground))
        for kind in totals:
            matched = int(associate(ground, boxes[kind], kind, info['width'], info['height']))
            row = totals[kind]
            row['referenceRegions'] += len(ground)
            row['predictedBoxes'] += len(boxes[kind])
            row['matchedRegions'] += matched
            row['annotatedSamples'] += 1
            detail[kind] = dict(boxes=len(boxes[kind]), matchedRegions=matched)
        details.append(detail)
    for row in totals.values():
        row['spatialAssociationCoveragePct'] = round(100 * row['matchedRegions'] / row['referenceRegions'], 3) if row['referenceRegions'] else None
    return dict(totals=totals, frames=details)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', type=Path, required=True)
    args = parser.parse_args()
    recording = json.loads((args.work / 'recording.json').read_text(encoding='utf8'))
    info_path = args.work / 'source-info.json'
    if info_path.exists():
        info = json.loads(info_path.read_text(encoding='utf8'))
    else:
        import cv2
        capture = cv2.VideoCapture(recording['sourcePath'])
        try:
            info = dict(width=int(capture.get(3)), height=int(capture.get(4)), fps=capture.get(5), frames=int(capture.get(7)))
        finally:
            capture.release()
    source = Path(recording['sourcePath']).stem
    labels = Path(__file__).resolve().parents[1] / 'tests/derived_release/derived_status_boxes.csv'
    references = {}
    with labels.open(encoding='utf8', newline='') as stream:
        for row in csv.DictReader(stream):
            if row['video'] == source:
                references.setdefault(int(row['frame_id']), []).append(tuple(float(row[key]) for key in ('x1', 'y1', 'x2', 'y2')))
    completed = [row for row in recording['requests'] if row.get('status') == 200 and row.get('end', float('inf')) <= recording['endedAt']]
    captured = [(min(info['frames'], int(row['sourceSeconds'] * info['fps']) + 1), row['data']) for row in completed]
    displayed = []
    overlay_path=args.work/'decision-overlays.json'
    rendered=json.loads(overlay_path.read_text(encoding='utf8')) if overlay_path.exists() else {}
    actual={item['frame']:item.get('geometry',[]) for item in rendered.get('decisions',[]) if 'frame' in item}
    current = -1
    for index in range(info['frames']):
        seconds = index / info['fps']
        while current + 1 < len(completed) and completed[current + 1]['completedSourceSeconds'] <= seconds + 1e-9:
            current += 1
        data=completed[current]['data'] if current>=0 else {}
        if index in actual:
            geometry={(item['kind'],item['id']):item['box'] for item in actual[index]}
            data={**data,'tracks':[{**track,'displayBoxes':{**track.get('displayBoxes',{}),
                **{kind:geometry[(kind,track['id'])] for kind in ('person','face') if (kind,track['id']) in geometry}}}
                for track in data.get('tracks',[])]}
        displayed.append((index + 1,data))
    result = dict(source=source, sourceFrames=info['frames'], annotatedFrames=len(references),
        continuity=replay_stability(recording),
        capturedAI=evaluate(captured, references, info, False),
        displayedOverLiveVideo=evaluate(displayed, references, info, True),
        criteria=dict(faces='One-to-one face center inside annotated head/shoulder region.',
            people='One-to-one body box covering at least 50% of an annotated head/shoulder region.'),
        limitations='Head/shoulder region association only. No full-body, tight-face, object or behavior ground truth; no AP, object recall or behavior accuracy claim. Live coverage includes startup delay and held delayed AI decisions.')
    (args.work / 'coverage.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps({key: result[key]['totals'] for key in ('capturedAI', 'displayedOverLiveVideo')}), flush=True)


if __name__ == '__main__':
    main()
