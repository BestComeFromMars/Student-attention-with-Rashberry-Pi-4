# Object motion fixture

`phone-and-book.jpg` and its original YOLO annotations come from COCO128,
image `000000000328.jpg` (COCO train2017), distributed by Ultralytics:

https://github.com/ultralytics/assets/releases/download/v0.0.0/coco128.zip

https://docs.ultralytics.com/datasets/detect/coco128/

The phone (class 67) and book (73) annotations are independent reference boxes.
Tests use controlled pixel motion and the pinned real VitTrack/YOLO models.
These are regression/sanity checks, not an independent model accuracy benchmark
and not a recording from the user's USB camera.
