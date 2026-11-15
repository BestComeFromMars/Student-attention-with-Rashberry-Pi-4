# Two different face regression fixtures

These 1280x720 JPEGs contain two **different public faces**, cropped, resized and
composited onto a plain background. They are synthetic layouts, not classroom
recordings and not a labeled face/behavior accuracy benchmark. No user camera
images are stored here. Each image should yield two face boxes.

- `two-frontal-profile.jpg`: TensorFlow.js portrait and Lombard Grid speaker 22.
- `two-different-profiles.jpg`: Lombard Grid speakers 16 and 22.
- `near-and-far.jpg`: TensorFlow.js portrait and a smaller speaker 16.
- `two-small.jpg`: the same two sources at approximately 55-68 face pixels.

The portrait comes from the [TensorFlow.js face-landmarks-detection test
fixture](https://github.com/tensorflow/tfjs-models/blob/master/face-landmarks-detection/test_data/portrait.jpg),
Copyright 2021 Google LLC, Apache-2.0. See `../README.md`.

The profile frames are derived from `s16_p_bgah2n2.mov` and `s22_p_sgbe5s2.mov`,
public side-view samples of the [Audio-Visual Lombard Grid Speech
corpus](https://spandh.dcs.shef.ac.uk/avlombard/), by Najwa Alghamdi, Steve Maddock,
Ricard Marxer, Jon Barker and Guy J. Brown. Licensed under
[Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
Changes: a video frame was extracted, the head cropped with padding, scaled,
composited and JPEG-encoded. No endorsement by the dataset authors is implied.

Reference: Alghamdi et al., *A corpus of audio-visual Lombard speech with frontal
and profile views*, JASA 143, EL523 (2018), https://doi.org/10.1121/1.5042758.

Run `npm run verify:faces` in `backend` after preparing the AI models. This uses
the real Python worker and both HTTP detection routes, without opening a webcam.
It also starts with one face, introduces the second into the same running
session, checks that it appears within 2.5 seconds and stays visible for eight
responses, and verifies that the first person's track ID survives the entry.

## Motion annotation used by `verify:tracking`

The approximate face rectangles in `two-frontal-profile.jpg` are marked as
`(213,249,193,287)` and `(830,246,185,283)` in source pixels `(x,y,width,height)`.
They are approximate manual regions for controlled motion checks, not a
formally annotated classroom benchmark. The test transforms these fixed regions
with the known image scale and checks overlap (IoU), session IDs and duplicate
tracks; it also reports size differences from the initial model prediction,
without treating that earlier prediction as ground truth.

