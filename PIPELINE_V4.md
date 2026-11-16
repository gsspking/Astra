# Local-LLM and single-GPU pipeline upgrade

The runtime is still **index.html**. It embeds the application and all extension code, requires no CDN/backend, and contacts only configured providers. `src/llm.js`, `src/analysis.js`, `src/pipeline.js` and `src/pipeline-ui.js` add the new workflow to the existing stores, generation queue, media store, production controls, and ExportService. Re-embed source edits with `python3 scripts/embed-delivery.py`.

## 1. Provider layer and simulation

Connections retains its existing editors and adds native Ollama/OpenAI-compatible controls: context/output budgets, temperature, request timeout, streaming, JSON mode, residency options, installed-model lookup and structured-output testing. Ollama uses `/api/chat`; streaming reads NDJSON. OpenAI-compatible streaming reads SSE. Requests share a Stop controller, reject length truncation, display live output/TPS and calibrate prompt-token estimates. Anthropic/Gemini paths retain their existing provider protocols and gain cancellation.

Simulation is explicit and watermarked in the Pipeline header, generated canvas media, source metadata and export manifest. It includes the bilingual sample, local image/WebM/WAV generation, latency and failure controls. Simulation does not contact providers.

Test: stream fragmented JSON/Telugu, Stop a request, force a timeout and `length` response, fetch installed models, and run the sample in simulation. Provider tests report the requested context accepted by the request, **not an exhaustively proven maximum capacity**. The optional context probe sends increasingly long marker-bearing inputs up to the configured window and records the largest verified input token count; it is a tested lower bound, not an exhaustive capacity proof. APIs that do not expose actual context capacity cannot establish it. Browser fetch cannot distinguish a CORS denial from a down server; diagnostics says so and lists server-specific fixes.

## 2. Skills, budgets and multi-pass analysis

Skills has editable task roles, defaulted from legacy types. Requests preserve selected-skill priority and include only matching roles and a small project context. Estimates treat Telugu conservatively until calibrated from usage. The request viewer shows the system/input/skills/output budget and every dropped low-priority skill. Scene text is windowed rather than sending the complete screenplay. Oversized indivisible input produces an actionable error instead of silent truncation. Bible input explicitly reports summary compaction; complete scene checkpoints remain stored.

Pass 0 reuses deterministic parsing with stable scene/shot IDs and speaker/language extraction. Passes 1–4 generate schema-validated scene analyses, bible entities, shots and prompts. Each item is stored before advancing. Shot validation checks maximum duration and exact dialogue coverage, with at most two item-level repair requests. Final validation checks project links, durations, prompts and coverage; unresolved errors block acceptance and remain available for manual editing. Run individual passes from Pipeline; prior passes must have valid checkpoints.

Pipeline shows paged scene diffs, editable candidate JSON and accept-all/per-scene actions. Accepting snapshots first and reuses production-preserving merging. Manual edits and locked shots are protected. Script → Analyze leaves a review checkpoint; Analyze offline explicitly uses deterministic parsing. A missing LLM never silently selects offline mode.

Test: analyze 60 scenes, Stop at scene 6, resume without duplicate checkpoint work, inspect Telugu dialogue, accept selected scenes and check approved versions/locks. Revise a prompt during an active request and verify that the stale result cannot overwrite it.

## 3. Hardware handoff

Settings → Hardware controls single-GPU mode, VRAM threshold/timeouts and manually supplied export-drive free space. Ollama unloading uses native `/api/generate` with `keep_alive: 0`, then checks `/api/ps`. Other servers support a configurable unload request and verification URL, or explicit manual confirmation. Verification endpoints must report `unloaded: true` or an empty `models` list; a generic installed-model list does not establish residency.

The handoff calls ComfyUI `/free`, polls `/system_stats` against the threshold, and logs before/after VRAM and timings. ComfyUI→LLM waits for an empty queue and frees cached models when prior ComfyUI work is known. Image→video boundaries free caches in single-GPU pipeline runs. Keep-warm skips LLM handoffs. A blocked handoff offers Retry, manual-unload confirmation, Continue anyway and Stop; it does not silently proceed.

Test: inspect Ollama `/api/ps` and ComfyUI VRAM before generation. Inject unload/verification failure and confirm the pipeline stays blocked. Real hardware behavior requires an installed provider; endpoint fixtures validate ordering but do not prove real VRAM reclamation.

## 4. Orchestrator

Pipeline has nine persisted stages with status, counters, timing, fingerprint and stale state. Full-auto advances enabled stages, Guided waits at configured gates, and Manual runs only on command. Mode changes are read at boundaries. Stage actions, selected-scene scope, Dry run, request preview, review and existing manual production tools share the same project data. Reload restores review checkpoints and marks interrupted running stages resumable. Changes mark completed work stale without deleting approved media.

Schema v4 adds orchestrator state and skill roles. First pipeline writes save a pre-v4 backup and snapshot; v1/v2/v3 files remain importable without automatic metadata changes. `project_schema_v4.json` documents the new fields. Existing legacy example/schema downloads remain available.

Test: Full-auto simulation from the bilingual sample through Delivery Pack, Guided Analyze gate, Manual idle behavior, reload/resume, script staleness and legacy import round trips. Keyboard controls: Alt+P pauses/resumes generation jobs, Alt+N runs the next stage, Alt+A continues a gate; existing take-review shortcuts remain available.

## 5. Production reliability

With chaining off, plans order reference jobs, all keyframes, then all videos. Stage-filtered runs share the existing queue and per-server concurrency. Chained segments retain order and previous-frame handling. Errors are classified: permanent failures are not retried; transient failures back off with fresh seeds; OOM calls `/free` and gets exactly one retry independent of the normal attempt budget. Cancellation is not retried. Counters distinguish success, failure, skipped and remaining; failure never produces `Finished` or a full success bar.

History monitoring uses worker delays and preserves prompt IDs through server outages. It retries history retrieval after recovery without a second submission; give-up leaves an explicit recovery action. Shots can be locked, and missing/selected/QC/failed/stale scopes are available. Lint errors block affected generation. Manual free-space estimates warn before large exports, and writes are checked by byte size before the manifest records success. Quota/permission failures remain blocking.

Test: missing node, OOM with attempts=1, transient retries with changed seeds, server outage during history monitoring, lock protection, keyframe-before-video order, and export write failure. In chaining mode the keyframe stage pairs image and video work by scene when Videos is enabled; the later Video stage picks up only missing work. The live job display shows the actual image/video class. Model-swap estimates are approximate for that mode.

## 6. Overnight work

Overnight mode requests Wake Lock, uses a Web Worker for polling/retry timers and heartbeat, and supports permission-gated browser notifications and a brief audio alert. Progress is persisted after jobs and checkpoints. The morning report is shown in-app; folder deliveries receive it and the redacted run log under `07_Reports`. Native browser/OS limitations still apply: sleeping the OS, closing the tab, or browser suspension stops execution; resume uses saved work.

Test: acquire/release Wake Lock, switch to a background tab, Stop/reload/resume, allow notifications and check the generated report. Browser permission prompts and actual OS sleep behavior require manual checks. A report-only ZIP export remains available when no folder is configured.

## 7. Lint, diagnostics and residency

Prompt lint is shown in the existing shot inspector and Pipeline, with required-token fixes and model-specific length/term/language checks. LLM rewrites remain a before/after proposal until accepted. Diagnostics runs offline self-tests, LLM/model/JSON/TPS checks, configured workflow checks, VRAM/queue queries, folder write/delete and quota/support checks, plus an explicit Test handoff button. Reports and the 500-entry IndexedDB run-log ring are redacted; authentication stays in the existing vault-backed Connections store.

LLM residency controls include VRAM estimate, keep-warm, unload method and learned TPS/load time when reported. Generation-model residency estimates can be edited in Diagnostics. ComfyUI does not consistently expose separate model-load timing; generation time measurements and manual swap estimates remain distinct from measured LLM load duration.

Test: offline self-tests, diagnostic failures and fix hints, required-token and conflicting-camera lint, rewrite diff acceptance, and searching exported logs/diagnostics for a configured secret. Diagnostics is not a claim that a provider accepted its maximum possible context or that an unsupported residency API verified an unload.

## Validation boundaries

Automated tests use Chromium and endpoint fixtures, plus real local canvas/MediaRecorder output for simulation. Installed Ollama/LM Studio/ComfyUI models, their actual VRAM release, native filesystem permission changes, OS sleep and browser notification behavior remain manual integration checks. The old 181-second real recording test remains available through `npm run test:long`. The app never substitutes simulation for real output unless Simulation is explicitly enabled.

Latest validation: **89 tests passed, zero failures, one optional long test skipped** in the full regression run. The real **181-second WebM export passed separately**. Additional targeted checks passed for bounded context probing/credential redaction and preserving schema v4 during ComfyUI audio attachment. Responsive checks passed after adding the horizontal stage tracker. No real Ollama/LM Studio/ComfyUI GPU was available here; physical unloading and VRAM thresholds remain integration checks against the user's configured endpoints.
