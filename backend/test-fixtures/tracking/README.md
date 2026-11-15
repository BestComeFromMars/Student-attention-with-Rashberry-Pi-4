# Public frontal/profile tracking fixtures

Four original sample videos from the [Audio-Visual Lombard Grid Speech corpus](https://spandh.dcs.shef.ac.uk/avlombard/), distributed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Attribution: Najwa Alghamdi, Steve Maddock, Ricard Marxer, Jon Barker and Guy J. Brown, “A corpus of audio-visual Lombard speech with frontal and profile views,” JASA 143, EL523 (2018), DOI [10.1121/1.5042758](https://doi.org/10.1121/1.5042758).

Each file is downloaded unchanged from `https://spandh.dcs.shef.ac.uk/avlombard/samples/<filename>`:

| File | View | SHA-256 |
| --- | --- | --- |
| s16_p_bgah2n.mov | Frontal | 9aeb5333c71f21b71e124d9c62ff4559a0f83257467b677de33603853c8761fa |
| s16_p_bgah2n2.mov | Profile | 76eb1402eaabfa7f006e7b39c957f3126ec9794b86b78bdeb207f32878e2a0c0 |
| s22_p_sgbe5s.mov | Frontal | a3b283956a36bd6cb4084d20c3a8bdb84324cb0e7c3557f73b0e9409916002ac |
| s22_p_sgbe5s2.mov | Profile | f6c68fa7ac0924db9e6441a409a80000c4f143e95c0862cdd9f7c5d1df76aa4b |

`ai/prepare_pose_cases.py` takes 16 evenly spaced frames per video. One case preserves native frames; another adds known horizontal translation, in-plane roll up to 25 degrees and scale changes on a 1280×720 background. Profile view comes from the actual side camera, not a synthetic perspective transform. Derived JPEGs go only to `.qa/pose-cases`.

`npm run verify:poses` in `backend` checks one visible face with the same session ID across each sequence, through upload and Pi-frame APIs (256 responses). The Pi route receives fixture JPEGs in memory; this does not connect a physical Pi or establish classroom accuracy. `ai/compare_pretrained_tracking.py` separately compares pretrained trackers against known translation/scale ground truth. NanoTrack comparison is optional and skipped when its development weights are absent; production uses VitTrack.
