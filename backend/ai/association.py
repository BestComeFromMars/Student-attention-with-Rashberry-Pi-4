"""Unique object ownership. None means the image does not establish an owner."""
import math


def contains(box, point, margin=.05):
    x,y,w,h = box
    return x-margin*w <= point[0] <= x+(1+margin)*w and y-margin*h <= point[1] <= y+(1+margin)*h


def associate_objects(bodies, objects, hands):
    values = {body["id"]:{63:False,67:False,73:False} for body in bodies}
    regions = {body["id"]:[] for body in bodies}
    for obj in objects:
        cls = obj["class"]
        if cls not in (63,67,73):
            continue
        x,y,w,h = obj["box"]
        center = (x+w/2,y+h/2)
        candidates,possible = [],[]
        for body in bodies:
            key = body["id"]
            if not contains(body["box"],center,.2):
                continue
            possible.append(key)
            points = hands.get(key,[])
            if cls == 63:
                keyboard = [x,y+h*.5,w,h*.55]
                near = [p for p in points if contains(keyboard,p,.12)]
                score = min((math.dist(p,center) for p in near),default=None)
            else:
                score = min((math.dist(p,center) for p in points),default=None)
                if score is not None and score > max(w*1.5,body["box"][2]*.2):
                    score = None
            if score is not None:
                candidates.append((score,key))
        candidates.sort()
        owner = candidates[0][1] if candidates and (len(candidates)==1 or
            candidates[0][0]+.01 < candidates[1][0]*.75) else None
        # A detector rectangle is useful even when an occluded hand prevents
        # confirmation. A unique body may carry the candidate rectangle, but
        # it must not create positive phone/book/laptop interaction evidence.
        region_owner = owner if owner is not None else possible[0] if len(possible) == 1 else None
        if region_owner is not None:
            left,top = max(0.,x),max(0.,y)
            right,bottom = min(1.,x+w),min(1.,y+h)
            if right > left and bottom > top:
                regions[region_owner].append(dict(kind={63:'laptop',67:'phone',73:'book'}[cls],
                    detectionId=obj.get('detectionId'),
                    box=dict(x=left,y=top,width=right-left,height=bottom-top),
                    confidence=float(obj.get('confidence',0.)),interaction=owner is not None))
        for key in possible:
            if key == owner:
                values[key][cls] = True
            elif owner is None and values[key][cls] is not True:
                values[key][cls] = None
    return values, regions


def object_evidence(bodies, objects, hands):
    return associate_objects(bodies, objects, hands)[0]
