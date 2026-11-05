# Cinematic production schema v2

The proposed structured fields are a good fit: they separate creative intent, acquisition settings, continuity state and model-specific planning from free-text notes. ASTRA now accepts v1 files, adds safe defaults and exports schemaVersion 2 without removing existing fields. The downloadable example, JSON schema and LLM instructions use v2.

| Proposal | Incorporated behavior |
| --- | --- |
| Structured shot planning | Shot inspector → Cinematic shot details: intent, emotion, coverage, camera/lens/acquisition settings, blocking, spatial continuity, composition, focus, start/end frames, alternate prompts, video negatives, QA, references and model overrides. |
| Vision and look bible | Project Setup → Cinematic production planning, with native editable fields. |
| Sequences, continuity events, model profiles | Editable collections in Project Setup; references are checked during native import. |
| Scene dramatic analysis and departmental breakdown | Expanded production scenes → Scene dramatic and department breakdown. |
| Asset continuity bible | Breakup inspector → Continuity bible, including identity/geography blocks and state/lighting/wardrobe variants. Populated idBlock/locBlock require explicit unlocking to edit. |
| Generation provenance | Shot inspector → Image/Video generation provenance; metadata stays attached to each version through import/export. Older versions remain valid without provenance. |
| Prompt use | Assembled image prompts include linked stable identity/geography, look style and shot composition/blocking/focus/start-frame direction. Video generation prefers the shot's videoNegativePrompt when supplied. New prompt fields inherit copy controls. |
| Complete LLM project workflow | Updated complete example, instructions and machine-readable schema include all new structures. Existing fields and source scene labels remain intact. |

## Intentional boundaries

- The four model names from the proposal are editable illustrative profiles. Their availability, version names and supported APIs were not independently verified. Profiles and modelOverrides are saved planning data; they do not install models or automatically route requests, apply parameters, retry with alternate prompts or select vendor endpoints. Existing Connections workflows remain responsible for execution.
- Provenance fields can be recorded and exported; existing generation adapters do not automatically fill modelProfileId, actual seed, hashes, dimensions or QA. Unknown values remain empty/null instead of inferred claims.
- Continuity flags/events and QA are filmmaker records, not automated visual verification of generated imagery. Reference validation checks ownership and links, not image content.
- captureFps is acquisition planning metadata. Project playback and duration budgets continue to use meta.frameRate and shot.duration; importing a high captureFps does not automatically retime clips.
- shotCode is an additional custom identifier. Existing scene-derived labels remain the displayed shot identifiers, preserving the established numbering/export behavior.
- Structured numeric fields are nullable when unspecified. Department list entries are readable descriptions; relationship fields use IDs. Per-provider parameter objects are edited as JSON because their keys vary by provider and version.
- JSON import is an explicit project revision and can replace identity blocks after review. Normal asset editing requires unlocking; script reanalysis retains existing assets and their stable descriptions.

## Suggested next increment

Choose a provider and a documented API/version for each model, then implement and test request mapping, reference upload, actual returned provenance and fallback behavior against that API. Automated continuity assessment needs separate acceptance criteria and should retain filmmaker review of any proposed changes.
