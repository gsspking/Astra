# ASTRA production workflow: phases 1–8

The shipped runtime remains **index.html**, with no new runtime library, CDN, server, account or telemetry. Readable extension sources are in `src/`; regenerate their embedded block with `python3 scripts/embed-delivery.py`. Existing compiled application code remains in the HTML.

## Phase 1 — Export & Delivery

Settings has a separate persisted export folder, permission/re-grant, write/delete test, templates, scope, root layout and overwrite policy. Downloads share sequential disk writing, SHA-256, atomic abort/cleanup, content-based skipping, manifest-last ordering, cancellation and reports. Timestamped exports reuse an interrupted root. Store-only ZIP/ZIP64 uses temporary origin-private storage when available; browsers without it have an explicit 64 MiB buffer limit. Exported video blobs are copied without encoding. PDF downloads read the selected page/grid/caption/field/cover/grayscale/watermark settings and rasterize one page at a time; native print remains available.

**Test:** choose a native folder, export, reload/re-grant, export again, cancel during writing, inspect the manifest and original media bytes. Test ZIP fallback separately. Long names over the 240-character path bound report an error and require a shorter template. Progress reports bytes/files and a measured estimate for the current file; it does not pre-scan an entire project to promise an exact overall ETA. Raster PDF text is not selectable.

## Phase 2 — Resilient jobs

ComfyUI prompt IDs are persisted before polling. Settings offers reconnecting without resubmission, per-kind monitoring timeouts and node/model checks. A shared per-server concurrency gate covers ComfyUI submissions. The production batch adds bounded exponential retry with fresh seeds, cancellation and a persistent failure list. Existing origin-project/revision guards are retained, and result storage completes before the job becomes done. Job journal storage uses the existing optional vault.

**Test:** reload during a ComfyUI prompt, resume monitoring, verify the originating target, test a provider failure and cancel a queued prompt. Running remote work may continue after queue removal is requested. Browser reload does not automatically restart an unattended batch; recover in-flight prompts, then rebuild its missing-work plan.

## Phase 3 — Takes and continuity

Auto-Produce → Review provides paged looping take comparison, approval/rejection metadata, bulk first-take approval, rejected regeneration, flags, fullscreen and keyboard help. Flick links to review. Neighbouring shot images provide context. Native video scrubbing plus Use current playback frame selects a derived continuity frame. Approved last-frame and segment chaining use browser decoding/canvas extraction. Locked linked references and selected angles are uploaded into numbered workflow reference tokens; references used are recorded. Approvals preserve alternatives.

**Test:** generate two takes, approve with the keyboard, reload, extract a chosen frame, and inspect provider inputs. Workflows must actually consume the supplied reference tokens; model reference support depends on the configured workflow.

## Phase 4 — Auto-Produce and estimator

The plan covers local screenplay breakdown when shots are absent, missing asset masters, keyframes, takes and model-limited segments. It previews stage counts, GPU-time/spend/storage estimates, checks workflow health and optional output prerequisites, then offers pause/resume, cancel and stop-after-current. Failed jobs continue into the review list. Generated masters become locked references. Timing averages are learned per profile/kind. Optional audio and Delivery Pack stages run after generation. Model parameters and per-shot workflow/prompt/seed/LoRA choices feed template variables.

**Test:** configure Connections and select server/workflows, check health, run a scene selection, pause/resume, fail a prompt, inspect the failure list and estimates. The automated 20-scene fixture test exercises retry, fresh seeds, persistence, QC and timings. It does not demonstrate output quality on an installed model. Estimates are estimates, and the browser cannot read native disk free space.

## Phase 5 — Delivery Pack

Delivery exports approved original clips, dialogue/cue audio, CMX3600 EDL, FCPXML 1.10, OTIO, markers, shot list, English/Telugu SRT, and missing/production/QC/prompt/timing reports. All three edit files share a frame-based timeline and relative clip paths. FCPXML and OTIO retain gaps for missing clips; EDL retains record-time gaps. Segmented takes export original parts with explicit order/durations in the timeline, rather than re-encoding them into a new original. Missing clips/audio remain visible in reports.

**Test:** import a Delivery Pack in your NLE and relink from its handoff directory. OpenTimelineIO 0.18.1 reads the generated OTIO successfully; FCPXML is checked as XML. A real NLE relink round trip is not yet verified in this environment. Relative URLs require keeping the exported hierarchy together; custom folder templates must preserve that relationship. Review WebM is exported separately from Rough Cut/Animatic and can accompany a pack.

## Phase 6 — Audio

The Audio panel assigns character voice IDs, language, speed and optional reference audio. Dialogue generation accepts ComfyUI voice workflows or existing web adapters; uploads remain available per line. Audio keeps shot/line/language links, supports offsets for subtitles, and is exported using its real MIME extension. Optional lip-sync creates another video version and checks the originating target before attachment. Music, SFX and scratch cues can be uploaded independently. No mastering or finishing mix is performed.

**Test:** generate/upload Telugu and English lines, regenerate one, round-trip the project, export audio, and exercise an optional lip-sync adapter. Voice-clone quality and support are provider-dependent. The scratch bed is for animatic review only.

## Phase 7 — QC, length planning and post-processing

Image/video QC samples decoded frames for darkness, near duplicates, brightness jumps, duration, dimensions/aspect, known FPS, and rough reference appearance difference. Every score/flag is retained without deleting media. Review offers the highest-scored take for approval. Model `parameters.maxClipLength` plans chained segments; `parameters.supportedFps` participates in preflight. Post-processing can run manually or after approval through a configured workflow, preserving the original and approving the processed version. A video upload path supplied by the installed ComfyUI video node is required.

**Test:** run QC on dark/frozen/wrong-duration clips, inspect flags, override a suggested take, generate a segmented shot, and run an installed upscale/interpolation/conform workflow. Similarity is a pixel heuristic, not face recognition. FPS is unknown unless supplied by the provider; this build does not infer it from video bitstreams.

## Phase 8 — Animatic, overrides, revisions and final checklist

The animatic reuses timed still/video WebM rendering, with optional uploaded scratch audio. Per-shot overrides and used references are shown in Review. Saving a revision baseline enables scene diffs and selection for regeneration while retaining existing takes. The final checklist displays approvals/audio/QC and verifies exported file hashes plus coverage of current approved takes and dialogue audio. Production metadata uses schema v3; first production writes retain a pre-migration backup and snapshot. Legacy project schemas remain importable. `project_schema_v3.json` is available separately; the legacy example/schema downloads remain v2.

**Test:** save a baseline, revise screenplay scenes, select changed scenes, generate alternatives, inspect overrides, render the animatic, export a pack and run verification. Keep the pre-migration backup until the project has been reviewed.

## Validation

`npm test` runs existing regression suites plus export, recovery and pipeline tests. The real-time recording check is `ASTRA_LONG_TEST=1 node --test --test-name-pattern='181-second export' tests/regression.test.cjs`.

Tests cover a 1,000-file export/repeat skip, atomic cancellation, ZIP64 readback using Python's standard ZIP reader, hash correctness against WebCrypto, Unicode/audio/project round trips, take approval, segmented paths, an unattended 20-scene provider fixture with retries, ComfyUI reload recovery and provider health failures. The real 181-second WebM test passes. Real filesystem permission revocation, multi-gigabyte media memory use, installed AI models and an actual NLE import remain manual validation boundaries.

Latest validation: the full suite completed **76 passing tests, zero failures, one optional long test skipped**. That long test passed separately with an actual 181-second WebM. The 20-scene fixture also passed with automatic Delivery Pack writing enabled. The OTIO handoff was read with OpenTimelineIO 0.18.1 and its external-reference path inspected; FCPXML parsing confirmed well-formed XML, not an NLE relink round trip.
