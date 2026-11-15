"""Controlled motion of real public phone/book pixels; never opens a camera."""
import json
import sys
from pathlib import Path
import cv2
import numpy as np

root=Path(__file__).resolve().parents[1]
output=Path(sys.argv[1]) if len(sys.argv)>1 else root.parent/'.qa/object-motion'
output.mkdir(parents=True,exist_ok=True)
source=cv2.imread(str(root/'test-fixtures/objects/phone-and-book.jpg'))
phone=next(list(map(float,line.split()[1:])) for line in (root/'test-fixtures/objects/phone-and-book.txt').read_text().splitlines() if line.startswith('67 '))
book=next(list(map(float,line.split()[1:])) for line in (root/'test-fixtures/objects/phone-and-book.txt').read_text().splitlines() if line.startswith('73 '))
rows=[]
def target(label,left,top,crop_left,crop_top,scale):
    cx,cy,w,h=label
    return dict(x=(left+((cx-w/2)*640-crop_left)*scale)/640,
        y=(top+((cy-h/2)*491-crop_top)*scale)/480,width=w*scale,height=h*491*scale/480)
for index,dx in enumerate(list(range(0,97,8))+list(range(88,-1,-8))):
    book_dx=-dx//2
    image=np.full((480,640,3),210,np.uint8)
    image[40:200,40:200]=cv2.resize(source[90:170,165:245],(160,160))
    image[120:213,380+dx:524+dx]=cv2.resize(source[276:307,428:476],(144,93))
    image[320:392,100+book_dx:241+book_dx]=cv2.resize(source[215:263,242:336],(141,72))
    name=f'{index:03}.jpg'
    cv2.imwrite(str(output/name),image,[cv2.IMWRITE_JPEG_QUALITY,90])
    rows.append(dict(path=name,dx=dx,phone=target(phone,380+dx,120,428,276,3),
                     book=target(book,100+book_dx,320,242,215,1.5)))
cv2.imwrite(str(output/'empty.jpg'),np.full((480,640,3),210,np.uint8))
objects_only=cv2.imread(str(output/'000.jpg'))
objects_only[40:200,40:200]=210
cv2.imwrite(str(output/'objects-only.jpg'),objects_only,[cv2.IMWRITE_JPEG_QUALITY,90])
(output/'manifest.json').write_text(json.dumps(dict(note=__doc__,width=640,height=480,frames=rows),indent=2),encoding='utf-8')
print(output)
