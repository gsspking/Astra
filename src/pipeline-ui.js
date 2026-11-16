function asPipelineForm() {
  const [message, setMessage] = j.useState("");
  return {
    message,
    setMessage,
    act:
      (fn) =>
      async (...args) => {
        try {
          await fn(...args);
        } catch (e) {
          setMessage(asRedact(e.message));
        }
      },
    button: (label, fn, disabled = false) =>
      asEl(
        Z,
        {
          onClick: async () => {
            try {
              await fn();
            } catch (e) {
              setMessage(asRedact(e.message));
            }
          },
          disabled,
        },
        label,
      ),
    field: (label, value, fn, type = "text") =>
      asEl(
        "label",
        {},
        label,
        asEl("input", {
          className: "field",
          type,
          value: value ?? "",
          onChange: (e) => {
            Promise.resolve(
              fn(type === "number" ? Number(e.target.value) : e.target.value),
            ).catch((e) => setMessage(e.message));
          },
        }),
      ),
    select: (label, value, choices, fn) =>
      asEl(
        "label",
        {},
        label,
        asEl(
          "select",
          {
            className: "field",
            value: value ?? "",
            onChange: (e) =>
              Promise.resolve(fn(e.target.value)).catch((e) =>
                setMessage(e.message),
              ),
          },
          ...choices.map(([value, label]) =>
            asEl("option", { key: value, value }, label),
          ),
        ),
      ),
    check: (label, value, fn) =>
      asEl(
        "label",
        { className: "flex gap-2 items-center" },
        asEl("input", {
          type: "checkbox",
          checked: !!value,
          onChange: (e) =>
            Promise.resolve(fn(e.target.checked)).catch((e) =>
              setMessage(e.message),
            ),
        }),
        label,
      ),
  };
}
function asLLMConfig() {
  const profiles = K((s) => s.llm),
    active = K((s) => s.activeLlmId),
    [models, setModels] = j.useState({}),
    [, refresh] = j.useReducer((n) => n + 1, 0),
    f = asPipelineForm();
  j.useEffect(() => {
    asLLMView.listeners.add(refresh);
    return () => asLLMView.listeners.delete(refresh);
  }, []);
  const save = (id, key, value) =>
    K.getState().update({
      llm: K.getState().llm.map((p) =>
        p.id === id ? { ...p, [key]: value } : p,
      ),
    });
  return asEl(
    "section",
    { className: "p-6 grid gap-4 border-b border-border" },
    asEl("h2", {}, "LLM provider controls"),
    f.button("Add Ollama profile", () => {
      const id = Zc("llm");
      K.getState().update({
        llm: [
          ...profiles,
          asLLMProfile({
            id,
            name: "Local Ollama",
            kind: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            model: "",
            apiKey: "",
          }),
        ],
        activeLlmId: id,
      });
    }),
    ...profiles.map((raw) => {
      const p = asLLMProfile(raw);
      return asEl(
        "details",
        { key: p.id, open: p.id === active },
        asEl("summary", {}, p.name + " — " + p.kind),
        f.select(
          "Provider kind",
          p.kind,
          [
            ["ollama", "Ollama native"],
            ["openai", "OpenAI-compatible"],
            ["anthropic", "Anthropic"],
            ["gemini", "Gemini"],
            ["simulation", "SIMULATION"],
          ],
          (v) => save(p.id, "kind", v),
        ),
        f.field("Server base URL", p.baseUrl, (v) => save(p.id, "baseUrl", v)),
        f.field("Model", p.model, (v) => save(p.id, "model", v)),
        f.button("Fetch installed models", async () => {
          setModels({
            ...models,
            [p.id]: await asLLMModels(p, AbortSignal.timeout(15000)),
          });
        }),
        models[p.id] &&
          f.select(
            "Installed model",
            p.model,
            models[p.id].map((name) => [name, name]),
            (v) => save(p.id, "model", v),
          ),
        ...[
          ["Context window (num_ctx)", "contextWindow"],
          ["Max output tokens", "maxOutputTokens"],
          ["Temperature", "temperature"],
          ["Timeout seconds", "timeoutSeconds"],
          ["VRAM estimate GB", "vramGB"],
        ].map(([label, key]) =>
          f.field(label, p[key], (v) => save(p.id, key, v), "number"),
        ),
        f.check("Stream response", p.streaming, (v) =>
          save(p.id, "streaming", v),
        ),
        f.select(
          "Structured output",
          p.structuredOutput,
          [
            ["json_schema", "JSON Schema"],
            ["json_object", "JSON object"],
            ["none", "None"],
          ],
          (v) => save(p.id, "structuredOutput", v),
        ),
        f.check("Keep warm (skip GPU handoffs)", p.keepWarm, (v) =>
          save(p.id, "keepWarm", v),
        ),
        f.select(
          "Unload method",
          p.unloadMethod,
          [
            ["ollama", "Ollama keep_alive: 0"],
            ["request", "Configured request"],
            ["manual", "Manual confirmation"],
          ],
          (v) => save(p.id, "unloadMethod", v),
        ),
        p.unloadMethod === "request" &&
          asEl(
            "div",
            { className: "grid gap-2" },
            f.select(
              "Unload HTTP method",
              p.unloadHttpMethod || "POST",
              [
                ["POST", "POST"],
                ["DELETE", "DELETE"],
                ["GET", "GET"],
              ],
              (v) => save(p.id, "unloadHttpMethod", v),
            ),
            f.field("Unload URL ({{model}} supported)", p.unloadUrl, (v) =>
              save(p.id, "unloadUrl", v),
            ),
            f.field("Unload JSON body", p.unloadBody, (v) =>
              save(p.id, "unloadBody", v),
            ),
            f.field("Residency verification URL", p.verifyUrl, (v) =>
              save(p.id, "verifyUrl", v),
            ),
          ),
        f.button("Test LLM and structured output", async () =>
          f.setMessage(JSON.stringify(await asLLMTest(p), null, 2)),
        ),
        f.button("Probe context up to configured window", async () =>
          f.setMessage(JSON.stringify(await asLLMContextProbe(p), null, 2)),
        ),
        f.button("Use this profile", () =>
          K.getState().update({ activeLlmId: p.id }),
        ),
      );
    }),
    asEl("p", { role: "status", style: { whiteSpace: "pre-wrap" } }, f.message),
    f.button("Stop LLM request", asLLMStop, !asLLMActive.size),
    asEl(
      "p",
      { role: "status" },
      asLLMView.status + " • " + asLLMView.tps.toFixed(1) + " tokens/s",
    ),
    asEl(
      "pre",
      { style: { maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" } },
      asLLMView.text,
    ),
  );
}
function asSkillRolePanel() {
  const project = G((s) => s.project),
    f = asPipelineForm();
  return asEl(
    "section",
    { className: "p-6 border-b border-border" },
    asEl("h2", {}, "Skill task roles"),
    asEl(
      "p",
      {},
      "Only selected project skills matching a pass role are sent. Existing priority order is retained.",
    ),
    ...project.skills.map((skill) =>
      asEl(
        "details",
        { key: skill.id },
        asEl("summary", {}, skill.name),
        ...asSkillRoles.map((role) =>
          f.check(role, asRoles(skill).includes(role), (value) => {
            G.getState().set((p) => ({
              ...p,
              skills: p.skills.map((s) =>
                s.id === skill.id
                  ? {
                      ...s,
                      roles: value
                        ? [...asRoles(s), role]
                        : asRoles(s).filter((r) => r !== role),
                    }
                  : s,
              ),
            }));
          }),
        ),
      ),
    ),
  );
}
function asHardwarePanel() {
  const state = K((s) => s.hardware),
    h = asHardware(),
    f = asPipelineForm(),
    save = (key, value) =>
      K.getState().update({ hardware: { ...asHardware(), [key]: value } });
  return asEl(
    "section",
    {
      className:
        "astra-delivery-panel grid gap-3 rounded-lg border border-border bg-card p-4",
    },
    asEl("h2", {}, "Hardware"),
    f.check("LLM and ComfyUI share one GPU", h.singleGPU, (v) =>
      save("singleGPU", v),
    ),
    ...[
      ["GPU VRAM GB", "vramGB"],
      ["Required free VRAM GB", "thresholdGB"],
      ["Handoff timeout seconds", "handoffTimeoutSeconds"],
      ["ComfyUI recovery give-up seconds", "giveUpSeconds"],
      ["Waiting alert after minutes", "waitingAlertMinutes"],
      ["Free space on export drive GB (manual)", "manualFreeGB"],
      ["Estimated model swap/load seconds", "swapSeconds"],
    ].map(([label, key]) =>
      f.field(label, h[key], (v) => save(key, Math.max(0, v)), "number"),
    ),
    asEl(
      "p",
      {},
      "Native disk free space is not readable by the browser. Update the manual figure before large runs.",
    ),
    asEl("p", { role: "status" }, f.message),
  );
}
function asPipelinePage() {
  const p = G((s) => s.project),
    settings = asProduction(p).settings,
    data = asPipelineData(p),
    sim = K((s) => s.simulation) || {},
    [, refresh] = j.useReducer((n) => n + 1, 0),
    [legacy, setLegacy] = j.useState(false),
    [analysisEdit, setAnalysisEdit] = j.useState(""),
    [analysisPage, setAnalysisPage] = j.useState(0),
    f = asPipelineForm();
  j.useEffect(() => {
    asPipelineRuntime.listeners.add(refresh);
    asBatch.listeners.add(refresh);
    asLLMView.listeners.add(refresh);
    return () => {
      asPipelineRuntime.listeners.delete(refresh);
      asBatch.listeners.delete(refresh);
      asLLMView.listeners.delete(refresh);
    };
  }, []);
  const save = (key, value) => asPipelineSave((d) => ({ ...d, [key]: value }));
  j.useEffect(() => {
    const key = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        asBatch.paused = !asBatch.paused;
        asBatchNotify();
      }
      if (e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        f.act(() => asPipelineRun({ only: asNextStage() }))();
      }
      if (e.altKey && e.key.toLowerCase() === "a")
        asPipelineRuntime.continue?.();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return asEl(
    "div",
    { className: "p-6 grid gap-4 astra-pipeline" },
    asEl(R_, {
      title: (asSimulationOn() ? "SIMULATION — " : "") + "Pipeline",
      sub: "One script-to-delivery workflow with manual, guided and full-auto control.",
    }),
    asEl(
      "nav",
      {
        "aria-label": "Stage tracker",
        className: "flex gap-2 overflow-x-auto",
        style: { maxWidth: "100%" },
      },
      ...asStageNames.map((name, index) =>
        asEl(
          "button",
          {
            key: index,
            style: { flex: "0 0 150px" },
            onClick: () =>
              document
                .getElementById("pipeline-stage-" + index)
                ?.scrollIntoView({ block: "center" }),
          },
          index +
            1 +
            ". " +
            name +
            " • " +
            (data.stages[index]?.status || "pending"),
        ),
      ),
    ),
    f.select(
      "Pipeline mode",
      data.mode,
      [
        ["full-auto", "Full-auto"],
        ["guided", "Guided"],
        ["manual", "Manual"],
      ],
      (v) => save("mode", v),
    ),
    f.check(
      "Use offline parser explicitly (no LLM)",
      data.offlineAnalysis,
      (v) => save("offlineAnalysis", v),
    ),
    f.select(
      "Work scope",
      settings.scope,
      [
        ["missing", "Missing"],
        ["selected", "Selected scenes"],
        ["qc", "QC-flagged only"],
        ["failed", "Failed only"],
        ["stale", "Stale only"],
      ],
      (scope) =>
        asProductionSave((d) => ({ ...d, settings: { ...d.settings, scope } })),
    ),
    settings.scope === "selected" &&
      asEl(
        "select",
        {
          className: "field",
          multiple: true,
          value: settings.sceneIds,
          onChange: (e) =>
            asProductionSave((d) => ({
              ...d,
              settings: {
                ...d.settings,
                sceneIds: [...e.target.selectedOptions].map((o) => o.value),
              },
            })),
        },
        ...p.scenes.map((s) =>
          asEl(
            "option",
            { key: s.id, value: s.id },
            asSceneLabel(s) + " " + s.slug,
          ),
        ),
      ),
    asEl(
      "div",
      { className: "flex flex-wrap gap-2" },
      f.button(
        "Run / Resume pipeline",
        () => asPipelineRun(),
        asPipelineRuntime.active,
      ),
      f.button(
        "Regenerate only stale",
        () => asPipelineRun({ staleOnly: true }),
        asPipelineRuntime.active,
      ),
      f.button(
        "Run next step",
        () => asPipelineRun({ only: asNextStage() }),
        asPipelineRuntime.active,
      ),
      f.button("Pause / Resume jobs", () => {
        asBatch.paused = !asBatch.paused;
        asBatchNotify();
      }),
      f.button("Stop after current job", () => {
        asBatch.stop = true;
        asPipelineRuntime.stopAfter = true;
      }),
      f.button("Stop now", () => {
        asPipelineRuntime.controller?.abort(
          new DOMException("Stopped by user", "AbortError"),
        );
        asBatch.controller?.abort();
        asLLMStop();
        asDelivery.cancel?.();
      }),
      f.button("Dry run (no provider calls)", async () => {
        asPipelineRuntime.dryRun = await asPipelineDryRun();
        asPipelineNotify();
      }),
    ),
    asEl(
      "p",
      { role: "status" },
      asPipelineRuntime.waiting
        ? "Waiting for ComfyUI"
        : asBatch.active
          ? asBatch.stage + ": " + asBatch.current
          : asPipelineRuntime.current || "Ready",
    ),
    asPipelineRuntime.handoffError &&
      asEl(
        "section",
        { role: "alert", className: "border border-border p-4" },
        asEl("p", {}, asPipelineRuntime.handoffError),
        f.button("I have unloaded it", () => {
          asPipelineRuntime.manualUnloadConfirmed = true;
          asPipelineRuntime.handoffChoice?.("retry");
        }),
        f.button("Retry handoff", () =>
          asPipelineRuntime.handoffChoice?.("retry"),
        ),
        f.button("Continue anyway", () =>
          asPipelineRuntime.handoffChoice?.("continue"),
        ),
        f.button("Stop handoff", () =>
          asPipelineRuntime.handoffChoice?.("stop"),
        ),
      ),
    asPipelineRuntime.gate &&
      asEl(
        "section",
        { className: "border border-border p-4" },
        asEl("p", {}, asPipelineRuntime.gate.message),
        asEl(
          "a",
          {
            href:
              asPipelineRuntime.gate.index === 0
                ? "#/script"
                : asPipelineRuntime.gate.index === 2
                  ? "#/breakup"
                  : "#/project",
          },
          "Open existing review page",
        ),
        f.button("Continue", () => asPipelineRuntime.continue?.()),
      ),
    asEl(
      "div",
      {
        className: "grid gap-2",
        role: "list",
        "aria-label": "Pipeline stages",
      },
      ...asStageNames.map((name, index) => {
        const stage = data.stages[index] || {};
        return asEl(
          "article",
          {
            key: index,
            id: "pipeline-stage-" + index,
            className: "border border-border rounded-lg p-3 grid gap-2",
            role: "listitem",
          },
          asEl(
            "h2",
            {},
            index +
              1 +
              ". " +
              name +
              " — " +
              (stage.status || "pending") +
              (stage.stale ? " • stale" : ""),
          ),
          asEl(
            "small",
            {},
            JSON.stringify(stage.counts || {}) +
              (stage.lastRun
                ? " • " + new Date(stage.lastRun).toLocaleString()
                : ""),
          ),
          stage.reason && asEl("p", { role: "alert" }, stage.reason),
          asEl(
            "div",
            { className: "flex flex-wrap gap-2" },
            f.check("Enabled", data.enabled[index], (v) =>
              save(
                "enabled",
                data.enabled.map((x, i) => (i === index ? v : x)),
              ),
            ),
            f.check("Pause for approval", data.gates.includes(index), (v) =>
              save(
                "gates",
                v
                  ? [...data.gates, index]
                  : data.gates.filter((i) => i !== index),
              ),
            ),
            f.button(
              "Run stage",
              () => asPipelineRun({ only: index }),
              asPipelineRuntime.active,
            ),
            f.button(
              "Run selected scenes",
              () =>
                save("selectedScenes", settings.sceneIds)
                  .then(() =>
                    asProductionSave((d) => ({
                      ...d,
                      settings: { ...d.settings, scope: "selected" },
                    })),
                  )
                  .then(() => asPipelineRun({ only: index })),
              asPipelineRuntime.active,
            ),
            f.button("Skip stage", () =>
              asPipelineStage(index, {
                status: "skipped",
                lastRun: Date.now(),
                stale: false,
              }),
            ),
            f.button(
              "Redo stage",
              async () => {
                await asPipelineStage(index, {
                  status: "pending",
                  stale: true,
                });
                await asPipelineRun({ only: index });
              },
              asPipelineRuntime.active,
            ),
          ),
        );
      }),
    ),
    asBatch.active &&
      asEl(
        "section",
        {},
        asEl("progress", {
          value: (asBatch.succeeded || 0) + (asBatch.skipped || 0),
          max: asBatch.total || 1,
          style: { accentColor: "#278b48" },
        }),
        asEl("progress", {
          value: asBatch.failures.length,
          max: asBatch.total || 1,
          style: { accentColor: "#c33" },
          "aria-label": "Failed jobs",
        }),
        asEl(
          "p",
          {},
          `${asBatch.succeeded || 0} succeeded • ${asBatch.failures.length} failed • ${asBatch.skipped || 0} skipped • ${Math.max(0, asBatch.total - (asBatch.succeeded || 0) - asBatch.failures.length - (asBatch.skipped || 0))} remaining`,
        ),
      ),
    asEl(
      "details",
      {},
      asEl("summary", {}, "Shot locks and prompt lint"),
      ...p.shots.slice(0, 100).map((shot) =>
        asEl(
          "div",
          { key: shot.id },
          f.check(
            asProductionCode(p, shot) + " — Lock against regeneration",
            asProduction(p).shots[shot.id]?.locked ||
              shot.lockedFields.includes("*"),
            (value) =>
              asProductionSave((d) => ({
                ...d,
                shots: {
                  ...d.shots,
                  [shot.id]: { ...d.shots[shot.id], locked: value },
                },
              })),
          ),
          ...asPromptLint(shot, p).map((issue, i) =>
            asEl(
              "p",
              { key: i },
              issue.severity + ": " + issue.message,
              issue.fix?.append &&
                f.button("Append required token", () => {
                  G.getState().updateShot(shot.id, {
                    imagePrompt: shot.imagePrompt + " " + issue.fix.append,
                    videoPrompt: shot.videoPrompt + " " + issue.fix.append,
                  });
                }),
            ),
          ),
        ),
      ),
    ),
    asEl(
      "details",
      {},
      asEl("summary", {}, "Failures"),
      ...(asProduction(p).batch?.failures || []).map((item, i) =>
        asEl(
          "div",
          { key: i },
          asEl("p", {}, item.task + ": " + item.reason),
          f.button("Retry item", () => asRetryFailure(i)),
          f.button("Skip item", () =>
            asProductionSave((d) => ({
              ...d,
              batch: {
                ...d.batch,
                failures: d.batch.failures.filter((_, at) => at !== i),
                skipped: (d.batch.skipped || 0) + 1,
              },
            })),
          ),
          asEl(
            "a",
            {
              href:
                "#/project" +
                (item.shotId ? "?shot=" + encodeURIComponent(item.shotId) : ""),
            },
            "Open shot",
          ),
        ),
      ),
    ),
    asEl(
      "section",
      { className: "grid gap-3" },
      asEl("h2", {}, "Simulation"),
      f.check(
        "SIMULATION providers (no GPU / no endpoint calls)",
        sim.enabled,
        async (value) => {
          K.getState().update({ simulation: { ...sim, enabled: value } });
          if (value && !K.getState().llm.some((p) => p.id === "simulation"))
            K.getState().update({
              llm: [
                ...K.getState().llm,
                asLLMProfile({
                  id: "simulation",
                  kind: "simulation",
                  name: "SIMULATION",
                  model: "simulation",
                  baseUrl: "",
                  contextWindow: 16384,
                  maxOutputTokens: 2048,
                }),
              ],
              activeLlmId: "simulation",
            });
          else if (value) K.getState().update({ activeLlmId: "simulation" });
          await save("simulation", value);
        },
      ),
      ...[
        ["Job latency ms", "latencyMs"],
        ["Transient error %", "transientPercent"],
        ["Out-of-memory error %", "oomPercent"],
        ["Permanent error %", "permanentPercent"],
      ].map(([label, key]) =>
        f.field(
          label,
          sim[key] || 0,
          (v) =>
            K.getState().update({
              simulation: { ...K.getState().simulation, [key]: Math.max(0, v) },
            }),
          "number",
        ),
      ),
      f.check("Inject invalid JSON", sim.invalidJSON, (v) =>
        K.getState().update({ simulation: { ...sim, invalidJSON: v } }),
      ),
      f.check("Inject truncated LLM output", sim.truncated, (v) =>
        K.getState().update({ simulation: { ...sim, truncated: v } }),
      ),
      f.button("Simulate 10-second ComfyUI crash", () =>
        K.getState().update({
          simulation: { ...sim, crashUntil: Date.now() + 10000 },
        }),
      ),
      f.button("Load three-scene Telugu / English sample", async () => {
        G.getState().snapshot("Before simulation sample");
        G.getState().set((p) => ({
          ...p,
          script: asSampleScreenplay,
          scriptElements: [],
          shots: [],
          scenes: [],
        }));
        await Ul();
      }),
    ),
    asEl(
      "section",
      { className: "grid gap-2" },
      f.check(
        "Overnight mode (request Wake Lock while running)",
        data.overnight,
        (v) => save("overnight", v),
      ),
      asEl(
        "p",
        {},
        "OS sleep, lid close, browser suspension or a closed page can still stop work. Worker timers do not prevent OS sleep.",
      ),
      f.button("Allow completion notifications", async () => {
        if (typeof Notification === "undefined")
          throw Error("Notifications unsupported");
        await Notification.requestPermission();
      }),
      asPipelineRuntime.wakeWarning &&
        asEl("p", {}, asPipelineRuntime.wakeWarning),
    ),
    asPipelineRuntime.promptRewrite &&
      asEl(
        "section",
        { className: "grid gap-2" },
        asEl("h2", {}, "Prompt rewrite diff"),
        asEl(
          "pre",
          { style: { whiteSpace: "pre-wrap" } },
          JSON.stringify(asPipelineRuntime.promptRewrite, null, 2),
        ),
        f.button("Accept rewritten prompts", async () => {
          const review = asPipelineRuntime.promptRewrite,
            shot = p.shots.find((s) => s.id === review.shotId);
          if (
            !shot ||
            shot.imagePrompt !== review.before.imagePrompt ||
            shot.videoPrompt !== review.before.videoPrompt
          )
            throw Error("Prompts changed since rewrite; review again");
          G.getState().updateShot(shot.id, {
            imagePrompt: review.after.imagePrompt,
            videoPrompt: review.after.videoPrompt,
            negativePrompt: review.after.negativePrompt,
          });
          await Ul();
          asPipelineRuntime.promptRewrite = null;
          asPipelineNotify();
        }),
      ),
    asPipelineRuntime.reviewAvailable &&
      !asPipelineRuntime.review &&
      f.button("Load saved analysis review", asAnalysisLoadReview),
    asPipelineRuntime.review &&
      asEl(
        "section",
        { className: "grid gap-2" },
        asEl("h2", {}, "Analysis checkpoint review"),
        asEl(
          "p",
          {},
          "Current: " +
            p.scenes.length +
            " scenes / " +
            p.shots.length +
            " shots. Proposed: " +
            asPipelineRuntime.review.candidate.scenes.length +
            " scenes / " +
            asPipelineRuntime.review.candidate.shots.length +
            " shots.",
        ),
        asEl("pre", {}, asPipelineRuntime.review.errors?.join("\n")),
        asEl("p", {}, asPipelineRuntime.mergeNotes?.join("; ")),
        asEl(
          "div",
          { className: "grid gap-2" },
          ...asPipelineRuntime.review.candidate.scenes
            .slice(analysisPage * 10, analysisPage * 10 + 10)
            .map((scene) =>
              asEl(
                "article",
                { key: scene.id, className: "border border-border p-2" },
                asEl("h3", {}, scene.slug),
                asEl(
                  "div",
                  { className: "grid gap-2 lg:grid-cols-2" },
                  asEl(
                    "pre",
                    { style: { whiteSpace: "pre-wrap" } },
                    JSON.stringify(
                      p.scenes.find((s) => s.id === scene.id) || {
                        status: "New scene",
                      },
                      null,
                      2,
                    ),
                  ),
                  asEl(
                    "pre",
                    { style: { whiteSpace: "pre-wrap" } },
                    JSON.stringify(scene, null, 2),
                  ),
                ),
                f.button("Accept scene " + asSceneLabel(scene), () =>
                  asAnalysisAccept([scene.id]),
                ),
              ),
            ),
          f.button("Previous analysis scenes", () =>
            setAnalysisPage(Math.max(0, analysisPage - 1)),
          ),
          f.button("Next analysis scenes", () =>
            setAnalysisPage(
              Math.min(
                Math.floor(
                  (asPipelineRuntime.review.candidate.scenes.length - 1) / 10,
                ),
                analysisPage + 1,
              ),
            ),
          ),
        ),
        f.button("Accept all analysis", () => asAnalysisAccept()),
        f.button("Accept selected scenes", () =>
          asAnalysisAccept(settings.sceneIds),
        ),
        f.button("Edit proposed JSON", () =>
          setAnalysisEdit(
            JSON.stringify(asPipelineRuntime.review.candidate, null, 2),
          ),
        ),
        analysisEdit &&
          asEl("textarea", {
            className: "field",
            rows: 10,
            value: analysisEdit,
            onChange: (e) => setAnalysisEdit(e.target.value),
          }),
        analysisEdit &&
          f.button("Validate edited proposal", () => {
            asPipelineRuntime.review.candidate = Uc.parse(
              JSON.parse(analysisEdit),
            );
            asPipelineRuntime.review.errors = asAnalysisValidate(
              asPipelineRuntime.review.candidate,
            );
            asPipelineNotify();
          }),
      ),
    asEl(
      "section",
      { className: "grid gap-2" },
      asEl("h2", {}, "Analysis passes"),
      ...[
        "Scene split (offline)",
        "Scene analysis",
        "Bible",
        "Shot design",
        "Prompts",
        "Validation",
      ].map((name, pass) =>
        f.button("Run pass " + pass + " — " + name, async () => {
          if (pass === 5) {
            const review = asPipelineRuntime.review;
            if (!review) throw Error("Run analysis first");
            review.errors = asAnalysisValidate(review.candidate);
            asPipelineRuntime.passResults = review.errors;
            asPipelineNotify();
            return;
          }
          await asAnalysisRun(G.getState().project, {
            passOnly: pass,
            sceneIds: settings.scope === "selected" ? settings.sceneIds : [],
          });
        }),
      ),
      asEl(
        "pre",
        { style: { maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap" } },
        JSON.stringify(asPipelineRuntime.passResults || {}, null, 2),
      ),
    ),
    asEl(
      "details",
      {},
      asEl("summary", {}, "What will be sent / token budget"),
      asEl("textarea", {
        readOnly: true,
        rows: 12,
        className: "field",
        value: asRedact(
          asPipelineRuntime.preview || asPipelineRuntime.dryRun || {},
        ),
      }),
    ),
    asEl(
      "details",
      {},
      asEl("summary", {}, "Live LLM output"),
      f.button("Stop LLM", asLLMStop),
      asEl(
        "p",
        {},
        asLLMView.status + " • " + asLLMView.tps.toFixed(1) + " tokens/s",
      ),
      asEl(
        "pre",
        { style: { maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" } },
        asLLMView.text,
      ),
    ),
    asEl(
      "details",
      {},
      asEl("summary", {}, "Run log / morning report"),
      asEl(
        "pre",
        { style: { maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" } },
        data.morningReport ||
          asPipelineRuntime.log.map((e) => JSON.stringify(e)).join("\n"),
      ),
      f.button("Export morning report", () =>
        asDeliveryRun([
          {
            path: "07_Reports/morning_report.md",
            open: () => asPipelineData().morningReport || "No completed run.",
          },
        ]),
      ),
      f.button("Export run log", () =>
        asDeliveryRun([
          {
            path: "07_Reports/run_log.jsonl",
            open: () =>
              asPipelineRuntime.log.map((e) => asRedact(e)).join("\n"),
          },
        ]),
      ),
    ),
    f.button(
      "Open take review / audio / QC / existing production controls",
      () => setLegacy(!legacy),
    ),
    legacy && asEl(asProductionPage, {}),
    f.button("Download pipeline schema v4", () =>
      ul("project_schema_v4.json", JSON.stringify(asPipelineJSONSchema)),
    ),
    asEl("a", { href: "#/diagnostics" }, "Diagnostics and self-tests"),
    asEl("p", { role: "status", style: { whiteSpace: "pre-wrap" } }, f.message),
  );
}
function asNextStage() {
  const data = asPipelineData();
  return asStageNames.findIndex(
    (_, i) =>
      data.enabled[i] && !["done", "skipped"].includes(data.stages[i]?.status),
  );
}
async function asPipelineDryRun() {
  const p = G.getState().project,
    profile = K.getState().llm.find((v) => v.id === K.getState().activeLlmId),
    plan = asProductionPlan(p),
    scenes = tl(p.script),
    llmPasses = scenes.length * 2 + 1 + Math.max(p.shots.length, scenes.length),
    swaps = plan.tasks
      .slice(1)
      .filter((task, i) => task.kind !== plan.tasks[i].kind).length;
  return {
    mode: asPipelineData().mode,
    simulation: asSimulationOn(),
    scriptScenes: scenes.length,
    llm: profile
      ? {
          model: profile.model,
          estimatedPasses: llmPasses,
          estimatedSeconds:
            llmPasses *
            (asLLMProfile(profile).maxOutputTokens /
              (profile.measuredTPS || 10)),
        }
      : null,
    generationJobs: plan.tasks,
    swaps,
    estimatedLoadSeconds:
      (swaps + (plan.tasks.length ? 1 : 0)) * asHardware().swapSeconds,
    estimatedGPUSeconds: plan.seconds,
    estimatedExportGB: plan.bytes / 1e9,
    manualFreeDriveGB: asHardware().manualFreeGB || "Not supplied",
    warnings:
      asHardware().manualFreeGB && asHardware().manualFreeGB < plan.bytes / 1e9
        ? ["Export-drive estimate exceeds manually supplied free space"]
        : [],
  };
}
async function asSelfTests() {
  const results = [];
  const test = (name, fn) => {
    try {
      fn();
      results.push({ name, status: "pass" });
    } catch (e) {
      results.push({ name, status: "fail", reason: e.message });
    }
  };
  test("JSON extraction preserves nested strings and Telugu", () => {
    if (
      asJSONExtract('```json\n{"line":"తెలుగు } [","nested":{"ok":true}}\n```')
        .line !== "తెలుగు } ["
    )
      throw Error("JSON parser failed");
  });
  test("Conservative Telugu token estimate", () => {
    if (asEstimateTokens("తెలుగు") <= asEstimateTokens("telugu"))
      throw Error("Telugu undercounted");
  });
  test("Three-scene deterministic split", () => {
    if (tl(asSampleScreenplay).length !== 3) throw Error("Scene split failed");
  });
  test("Permanent/OOM/transient classification", () => {
    if (
      asErrorClass(Error("missing node")) !== "permanent" ||
      asErrorClass(Error("CUDA out of memory")) !== "oom" ||
      asErrorClass(Error("HTTP 503")) !== "transient"
    )
      throw Error("Error classification failed");
  });
  return results;
}
async function asDiagnostics() {
  const results = await asSelfTests(),
    check = async (name, fn, fix) => {
      try {
        results.push({ name, status: "pass", evidence: await fn() });
      } catch (e) {
        results.push({
          name,
          status: "fail",
          reason: asRedact(e.message),
          fix,
        });
      }
    };
  const profile = K.getState().llm.find(
    (p) => p.id === K.getState().activeLlmId,
  );
  if (profile)
    await check(
      "LLM models / structured output / measured TPS",
      () => asLLMTest(profile),
      "Check server, installed model, CORS and JSON mode.",
    );
  else
    results.push({
      name: "LLM",
      status: "warn",
      reason:
        "No active profile. Choose a provider or explicit offline parsing.",
    });
  await check(
    "ComfyUI VRAM",
    () => asVRAM(AbortSignal.timeout(15000)),
    "Run ComfyUI with --enable-cors-header and select its server.",
  );
  await check(
    "ComfyUI queue",
    () => asComfyCall("/queue", { signal: AbortSignal.timeout(15000) }),
    "Restart ComfyUI or check its configured origin.",
  );
  for (const workflow of K.getState().workflows)
    await check(
      "Workflow " + workflow.name,
      async () => {
        const errors = await asJobHealth(asComfySelected(), workflow);
        if (errors.length) throw Error(errors.join("; "));
        return "Nodes and model choices available";
      },
      "Install missing nodes/models or correct the workflow.",
    );
  await check(
    "Export folder write/delete",
    asDeliveryTest,
    "Choose or re-grant the export folder.",
  );
  await check(
    "IndexedDB quota",
    () => navigator.storage.estimate(),
    "Free browser storage if quota is insufficient.",
  );
  results.push(
    { name: "Wake Lock", status: navigator.wakeLock ? "pass" : "warn" },
    {
      name: "File System Access",
      status: window.showDirectoryPicker ? "pass" : "warn",
      fix: "Use Chromium for native folders; ZIP is the fallback.",
    },
    {
      name: "CORS evidence",
      status: "warn",
      reason:
        "Browser fetch cannot distinguish a CORS denial from a down server; inspect server logs/devtools. Ollama: OLLAMA_ORIGINS=*. LM Studio: enable CORS. ComfyUI: --enable-cors-header.",
    },
  );
  return results;
}
function asDiagnosticsPage() {
  const [results, setResults] = j.useState([]),
    f = asPipelineForm();
  return asEl(
    "div",
    { className: "p-6 grid gap-4" },
    asEl(R_, {
      title: "Diagnostics",
      sub: "Checks contact only configured providers. Reports omit credentials.",
    }),
    f.button("Run all checks", async () => setResults(await asDiagnostics())),
    f.button("Run offline self-tests", async () =>
      setResults(await asSelfTests()),
    ),
    f.button("Test handoff", async () => {
      const profile = K.getState().llm.find(
        (p) => p.id === K.getState().activeLlmId,
      );
      if (!profile) throw Error("Choose an LLM profile");
      await asHardwareToComfy(profile, AbortSignal.timeout(120000));
      f.setMessage("Handoff verified");
    }),
    f.button("Copy diagnostics report", () =>
      navigator.clipboard.writeText(asRedact(results)),
    ),
    asEl("textarea", {
      readOnly: true,
      className: "field",
      rows: 15,
      value: asRedact(results),
    }),
    asEl("h2", {}, "Model residency"),
    ...K.getState().llm.map((p) =>
      asEl(
        "p",
        { key: p.id },
        p.name +
          " • " +
          (p.vramGB || "unknown") +
          " GB • keep warm " +
          !!p.keepWarm +
          " • unload " +
          asLLMProfile(p).unloadMethod +
          " • " +
          (p.measuredTPS || 0).toFixed(1) +
          " tokens/s",
      ),
    ),
    asEl(
      "a",
      { href: "#/connections" },
      "Edit residency and provider settings",
    ),
    asEl("p", { role: "status" }, f.message),
  );
}
function asPromptLintPanel({ shot, project }) {
  const f = asPipelineForm(),
    issues = asPromptLint(shot, project);
  return asEl(
    "section",
    { className: "grid gap-2 p-3 border border-border rounded-lg" },
    asEl("h3", {}, "Prompt lint"),
    asEl(
      "p",
      {},
      issues.length ? issues.length + " findings" : "No prompt-lint findings",
    ),
    ...issues.map((issue, i) =>
      asEl(
        "div",
        { key: i },
        asEl("p", {}, issue.severity + ": " + issue.message),
        issue.fix?.append &&
          f.button("Append required token", () =>
            G.getState().updateShot(shot.id, {
              imagePrompt: shot.imagePrompt + " " + issue.fix.append,
              videoPrompt: shot.videoPrompt + " " + issue.fix.append,
            }),
          ),
      ),
    ),
    f.button("Rewrite prompts with LLM (preview)", async () => {
      const profile = K.getState().llm.find(
        (p) => p.id === K.getState().activeLlmId,
      );
      if (!profile) throw Error("Choose an LLM profile");
      const result = await asAnalysisPass(
        project,
        asLLMProfile(profile),
        4,
        {
          shot: {
            action: shot.action,
            imagePrompt: shot.imagePrompt,
            videoPrompt: shot.videoPrompt,
          },
          lint: issues,
        },
        "rewrite:" + shot.id,
        () => ({
          imagePrompt: "SIMULATION " + shot.action,
          videoPrompt: "SIMULATION " + shot.action,
          negativePrompt: shot.negativePrompt,
          references: [],
        }),
      );
      asPipelineRuntime.promptRewrite = {
        shotId: shot.id,
        before: {
          imagePrompt: shot.imagePrompt,
          videoPrompt: shot.videoPrompt,
        },
        after: result,
      };
      asPipelineNotify();
      f.setMessage(
        "Preview is ready on the Pipeline page; it has not overwritten the shot.",
      );
    }),
    asEl("p", { role: "status" }, f.message),
  );
}
const asPipelineCSS = document.createElement("style");
asPipelineCSS.textContent = `.astra-pipeline{min-width:0;overflow-wrap:anywhere}.astra-pipeline>*,.astra-pipeline section,.astra-pipeline article{min-width:0}.astra-pipeline pre{max-width:100%;overflow:auto;white-space:pre-wrap}.astra-pipeline button{white-space:normal;min-height:36px;height:auto;padding-top:7px;padding-bottom:7px;max-width:100%}.astra-pipeline input,.astra-pipeline select,.astra-pipeline textarea{min-width:0;max-width:100%}.astra-pipeline progress{width:100%}@media(max-width:767px){.astra-workspace[data-workspace=skills] .flex.gap-2{flex-wrap:wrap}.astra-pipeline{padding:16px}.astra-pipeline button{min-height:44px}}`;
document.head.append(asPipelineCSS);
