# ASTRA Studio

Open `index.html` in a current browser, or serve it with a static HTTP server. The application remains a single self-contained HTML file; Node.js is only used for regression tests.

- Home combines the project overview with production metrics, stage progress, the scene/shot heat map and film timeline. Old Dashboard links redirect to Home. Use Upload banner / Change banner on the top image to save a banner for the current project, or Reset banner to restore the default. Banners are separate from project thumbnails and included in full project backups.
- Projects autosave to IndexedDB after edits. Optional folder mirrors run after three seconds without edits. Save errors are shown, and the Saved timestamp advances only after a successful write.
- Script accepts Final Draft `.fdx`, Fountain, Markdown and plain text. The default Screenplay view uses screenplay-style action, character, dialogue, parenthetical and transition positions, with source scene labels on both margins. FDX imports retain paragraph types, bold/italic/underline runs and dual dialogue. Edit source remains available; saved script versions preserve imported formatting.
- Raw Scene Count is the total number of scene headings. Script scene labels such as `1`, `1A`, `1B`, `4A` and `4B` are stored separately from numeric ordering and carried through analysis, breakdown links, scene filters, shot codes and exports. Fountain `#1A#` markers and prefixed scene labels are supported. Unnumbered headings use automatic sequential labels.
- Script analysis retains existing shot edits, approvals, media and asset records. Scenes outside the current screenplay move to Retained production scenes, excluded from active counts. Their shots remain in backups, can be exported separately from Script, and return when those scenes are reintroduced. An analysis response is rejected if the project changed while the request was running.
- Generation templates support `{{fps}}`, `{{duration}}`, `{{frames}}`, `{{num_frames}}` and `{{frame_count}}`. FPS comes from Project Setup; duration comes from the target shot. Asset-only generations default to three seconds. Frame counts are rounded from FPS × duration; individual model workflows may require their own frame-count adjustments.
- Local images and videos are stored once as content-addressed blobs, with lightweight references in project history and snapshots. Existing embedded-media projects migrate when opened. Full JSON downloads and folder mirrors include local media as data URLs for portability. Imported remote URLs remain remote references.
- Settings → Reclaim unused media removes files unreferenced by any saved project, current undo/redo history or snapshot. Newly attached media is protected briefly while saves settle. Optimize storage retains approved/latest shot versions; retained history and snapshots still keep their media until those references are removed.
- Storyboard/PDF shot codes sit above the top-left edge of each frame, including when captions are hidden or placed to the right. WebM shot codes and action text use a separate 32-pixel top header so the picture stays unobstructed; the picture area preserves the project aspect ratio.
- Rough Cut exports WebM with available source-video audio, project FPS and full shot durations. Long exports stream to a selected file in browsers supporting `showSaveFilePicker`. Other browsers use a 64 MB output buffer and stop with an explicit error if it fills. Export runs in real time, can be cancelled, and reports media failures. Sound-cue text is metadata; no dialogue or soundtrack is synthesized. WebM reviews are not finishing masters.

## Regression tests

Requires Node.js, Chromium, FFmpeg and ffprobe. Install test dependencies with `npm ci`. Set `CHROMIUM_PATH` if Chromium is not at `/usr/bin/chromium`.

```sh
npm test
npm run test:long
```

The long test records and inspects a real 181-second streamed WebM. Tests cover screen navigation, idle saves, folder mirroring, save failures, reanalysis, media deduplication/migration/cleanup, portable backups, generation request variables, audible source audio, aspect ratio and export cancellation. Provider requests are intercepted fixtures; real installed LLM/ComfyUI models are not required. Test outputs are written under ignored `test-results/`.
