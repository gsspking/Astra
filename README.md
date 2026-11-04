# ASTRA Studio

Open `ASTRA_Studio_V4F.html` in a current browser, or serve it with a static HTTP server. The application remains a single self-contained HTML file; Node.js is only used for regression tests.

- Home combines the project overview with production metrics, stage progress, the scene/shot heat map and film timeline. Old Dashboard links redirect to Home. Use Upload banner / Change banner on the top image to save a banner for the current project, or Reset banner to restore the default. Banners are separate from project thumbnails and included in full project backups.
- Projects autosave to IndexedDB after edits. Optional folder mirrors run after three seconds without edits. Save errors are shown, and the Saved timestamp advances only after a successful write.
- Script analysis retains existing shot edits, approvals, media and asset records. It adds new scenes and assets; scenes removed from the screenplay remain available so production work is not discarded. Reanalysis can update scene text and numbering. An analysis response is rejected if the project changed while the request was running.
- Generation templates support `{{fps}}`, `{{duration}}`, `{{frames}}`, `{{num_frames}}` and `{{frame_count}}`. FPS comes from Project Setup; duration comes from the target shot. Asset-only generations default to three seconds. Frame counts are rounded from FPS × duration; individual model workflows may require their own frame-count adjustments.
- Local images and videos are stored once as content-addressed blobs, with lightweight references in project history and snapshots. Existing embedded-media projects migrate when opened. Full JSON downloads and folder mirrors include local media as data URLs for portability. Imported remote URLs remain remote references.
- Settings → Reclaim unused media removes files unreferenced by any saved project, current undo/redo history or snapshot. Newly attached media is protected briefly while saves settle. Optimize storage retains approved/latest shot versions; retained history and snapshots still keep their media until those references are removed.
- Rough Cut exports WebM with available source-video audio, project aspect ratio/FPS and full shot durations. Long exports stream to a selected file in browsers supporting `showSaveFilePicker`. Other browsers use a 64 MB output buffer and stop with an explicit error if it fills. Export runs in real time, can be cancelled, and reports media failures. Sound-cue text is metadata; no dialogue or soundtrack is synthesized. WebM reviews are not finishing masters.

## Regression tests

Requires Node.js, Chromium, FFmpeg and ffprobe. Install test dependencies with `npm ci`. Set `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`.

```sh
npm test
npm run test:long
```

The long test records and inspects a real 181-second streamed WebM. Tests cover screen navigation, idle saves, folder mirroring, save failures, reanalysis, media deduplication/migration/cleanup, portable backups, generation request variables, audible source audio, aspect ratio and export cancellation. Provider requests are intercepted fixtures; real installed LLM/ComfyUI models are not required. Test outputs are written under ignored `test-results/`.
