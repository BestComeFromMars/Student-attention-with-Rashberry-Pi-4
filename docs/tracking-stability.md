# Camera rectangle stability

The geometry process measures current-image optical flow independently of semantic
inference. Every displayed rectangle belongs to the immutable image presented
with it. Detection results are projected from their source image before use.

The display refinement uses the [1€ Filter](https://gery.casiez.net/1euro/)
(Casiez, Roussel and Vogel, CHI 2012) on accumulated measured log scale. Its
bandwidth increases with measured scale speed, suppressing stationary size noise
while following approach/retreat. Width and height remain positive. Current-image
translation is carried directly; it is not filtered or extrapolated.

Projected detector corrections use an exact critically damped second-order
response with speed-dependent bandwidth and bounded correction rates. A new
detector result changes the target without resetting correction velocity. This
applies to person, face and object rectangles. The display rectangle does not
feed back into feature selection: small faces retain the established measurement
support even while their displayed correction settles.

Camera capture intervals, sent in the optional `X-Frame-Captured-At` header
(milliseconds from the browser's monotonic clock), control refinement time.
Server processing intervals are a compatibility fallback. Server monotonic time
continues to expire stale evidence; client timestamps cannot extend its lifetime.
Duplicate/late frame IDs cannot rewind the geometry worker.

## Research considered

- [SmoothNet, ECCV 2022](https://www.ecva.net/papers/eccv_2022/papers_ECCV/papers/136650615.pdf)
  addresses temporal jitter in pose sequences. It motivates checking acceleration
  as well as displacement. The learned pose refiner is not installed here.
- [CoTracker3](https://cotracker3.github.io/) provides learned point tracking,
  including an online variant. Its [official implementation](https://github.com/facebookresearch/co-tracker)
  strongly recommends a GPU and processes online video in chunks. This machine
  has four physical CPU cores and no CUDA device. No claim is made that this
  model meets the current camera's per-frame budget; it has not been installed
  or benchmarked in this change.
- [SAMURAI](https://arxiv.org/abs/2411.11922) adds motion-aware memory selection
  to SAM 2 for segmentation tracking. That is a separate model pipeline with
  different runtime costs, not a drop-in display filter; it is not installed.

The implemented refinement is a CPU-compatible application of adaptive filtering
and continuous detector correction, not an implementation of those neural models.

## Validation

`backend/ai/test_box_refinement.py` and `test_pixel_tracking.py` check noise
attenuation, real zoom, translation starts/stops/reversals, retarget continuity,
different camera rates, bursty delivery, stale evidence and source frame identity.
The full unattended replay is:

```sh
node frontend/scripts/replay-camera-video.mjs --file backend/tests/videos/class_3.mp4 --work .qa/REPLAY --record-only
node frontend/scripts/render-decision-video.mjs --work .qa/REPLAY --output .qa/REPLAY/class_3.mp4
```

Compare the old and new implementations on identical source frames and completed
AI results. Check identity presence, normalized center acceleration and log-size
acceleration. These measure continuity, not ground-truth detection accuracy. Live
FPS and presentation latency are separate from the exported MP4's frame rate.
Only the final MP4 goes in `backend/tests/test_results`; diagnostics stay in `.qa`.
