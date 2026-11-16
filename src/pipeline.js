const asStageNames = [
  "Analyze script",
  "Handoff LLM → ComfyUI",
  "Reference sheets",
  "Keyframes",
  "Videos",
  "Post-process / upscale",
  "QC",
  "Audio",
  "Delivery Pack export",
];
const asPipelineRuntime = {
  active: false,
  controller: null,
  gate: null,
  preview: null,
  review: null,
  applying: false,
  log: [],
  listeners: new Set(),
  worker: null,
  waiting: false,
};
function asPipelineNotify() {
  for (const listener of asPipelineRuntime.listeners) listener();
}
function asPipelineData(p = G.getState().project) {
  return {
    mode: "manual",
    gates: [0, 2, 3],
    enabled: asStageNames.map((_, i) => ![5, 7].includes(i)),
    stages: {},
    overnight: false,
    ...p.pipeline,
  };
}
let asPipelineWrites = Promise.resolve();
async function asPipelineSave(change) {
  const id = Kl.getState().activeId;
  const result = asPipelineWrites
    .catch(() => {})
    .then(async () => {
      if (Kl.getState().activeId !== id)
        throw Error(
          "Project changed; pipeline state was not written into another project.",
        );
      if (G.getState().project.schemaVersion < 4) {
        const p = G.getState().project;
        await asWriteStored("astra-pre-v4-" + id, p);
        G.getState().snapshot("Before pipeline schema v4 migration");
      }
      asPipelineRuntime.applying = true;
      try {
        G.getState().set((p) => ({
          ...p,
          schemaVersion: 4,
          skills: p.skills.map((s) => ({ ...s, roles: asRoles(s) })),
          pipeline: change(asPipelineData(p)),
        }));
        await asPersistProject(
          "filmforge-project",
          JSON.stringify({
            state: {
              project: G.getState().project,
              snapshots: G.getState().snapshots,
            },
            version: 0,
          }),
        );
      } finally {
        asPipelineRuntime.applying = false;
      }
      asPipelineNotify();
    });
  asPipelineWrites = result;
  return result;
}
async function asFingerprint(value) {
  const normalized = typeof value === "string" ? value : JSON.stringify(value);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
function asPipelineTimerInit() {
  if (asPipelineRuntime.worker) return;
  const blob = new Blob(
      [
        `const tasks=new Map();onmessage=e=>{const {id,delay,cancel}=e.data;if(cancel){clearTimeout(tasks.get(id));tasks.delete(id);}else tasks.set(id,setTimeout(()=>{tasks.delete(id);postMessage({id});},delay));};setInterval(()=>postMessage({heartbeat:Date.now()}),15000);`,
      ],
      { type: "application/javascript" },
    ),
    url = URL.createObjectURL(blob);
  try {
    const worker = new Worker(url);
    worker.onmessage = (e) => {
      if (e.data.heartbeat) {
        asPipelineRuntime.heartbeat = e.data.heartbeat;
        return;
      }
      const fn = asPipelineTimers.get(e.data.id);
      if (fn) {
        asPipelineTimers.delete(e.data.id);
        fn();
      }
    };
    asPipelineRuntime.worker = worker;
  } catch (e) {
    asPipelineRuntime.workerError =
      "Background worker unavailable; timers use the main thread.";
  } finally {
    URL.revokeObjectURL(url);
  }
}
const asPipelineTimers = new Map();
function asPipelineDelay(ms, signal) {
  signal?.throwIfAborted();
  asPipelineTimerInit();
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let timer;
    const done = () => {
      signal?.removeEventListener("abort", abort);
      asPipelineTimers.delete(id);
      resolve();
    };
    const abort = () => {
      asPipelineRuntime.worker?.postMessage({ id, cancel: true });
      clearTimeout(timer);
      asPipelineTimers.delete(id);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason || new DOMException("Stopped", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (asPipelineRuntime.worker) {
      asPipelineTimers.set(id, done);
      asPipelineRuntime.worker.postMessage({ id, delay: Math.max(0, ms) });
    } else timer = setTimeout(done, ms);
  });
}
function asSimulationOn() {
  return !!K.getState().simulation?.enabled;
}
function asSimulationFailure(kind) {
  const s = K.getState().simulation || {};
  if (s.crashUntil > Date.now()) throw Error("Simulation ComfyUI unreachable");
  const random = Math.random() * 100;
  if (random < (s.permanentPercent || 0))
    throw Error("Simulation permanent: missing model");
  if (random < (s.permanentPercent || 0) + (s.oomPercent || 0))
    throw Error("Simulation out of memory");
  if (
    random <
    (s.permanentPercent || 0) + (s.oomPercent || 0) + (s.transientPercent || 0)
  )
    throw Error("Simulation HTTP 503 transient failure");
}
async function asSimulationMedia(options, signal) {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext("2d");
  const draw = () => {
    ctx.fillStyle = "#18120a";
    ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = "#f9a51a";
    ctx.font = "bold 21px sans-serif";
    ctx.fillText("SIMULATION", 15, 34);
    ctx.font = "13px sans-serif";
    ctx.fillText((options.label || "ASTRA").slice(0, 38), 15, 70);
    ctx.fillText((options.prompt || "").slice(0, 42), 15, 105);
    ctx.fillRect(15 + Math.sin(performance.now() / 250) * 10, 140, 35, 5);
  };
  draw();
  if (options.kind !== "video") {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    canvas.width = 0;
    return blob;
  }
  const stream = canvas.captureStream(12),
    recorder = new MediaRecorder(stream, { mimeType: "video/webm" }),
    chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve;
    recorder.onerror = (e) =>
      reject(e.error || Error("Simulation recorder failed"));
  });
  try {
    recorder.start(250);
    const duration =
      options.segment?.duration ||
      asGenerationVariables(G.getState().project, options.target).duration ||
      1;
    for (let time = 0; time < duration * 1000; time += 80) {
      signal?.throwIfAborted();
      draw();
      await asPipelineDelay(Math.min(80, duration * 1000 - time), signal);
    }
    recorder.stop();
    await stopped;
    return new Blob(chunks, { type: "video/webm" });
  } finally {
    if (recorder.state !== "inactive") {
      recorder.stop();
      await stopped;
    }
    stream.getTracks().forEach((t) => t.stop());
    canvas.width = 0;
  }
}
async function asSimulationGenerate(options) {
  const run = asBeginGeneration(options, "simulation");
  try {
    await asSaveJobs();
    await asPipelineDelay(
      K.getState().simulation?.latencyMs || 20,
      run.controller.signal,
    );
    asSimulationFailure("comfy");
    const blob = await asSimulationMedia(options, run.controller.signal);
    run.job.simulatedDuration =
      options.segment?.duration ||
      asGenerationVariables(G.getState().project, options.target).duration;
    await asCompleteGeneration(run, await asMediaPut(blob), "SIMULATION");
    return K.getState().jobs.find((j) => j.id === run.id);
  } catch (e) {
    K.getState().patchJob(run.id, {
      status: run.controller.signal.aborted ? "cancelled" : "failed",
      log: e.message,
    });
    throw e;
  } finally {
    run.finish();
    await asSaveJobs();
  }
}
const asSampleScreenplay =
  "INT. టీ దుకాణం - ఉదయం\n\nమీరా కిటికీ దగ్గర నిలబడింది.\n\nMEERA\nనమస్తే రవి.\n\nEXT. BUS STOP - DAY\n\nRavi looks at the approaching bus.\n\nRAVI\nWe still have time.\n\nINT. ఇంటి గది - సాయంత్రం\n\nThey sit together.\n\nMEERA\nమళ్లీ కలుద్దాం.\n";
function asHardware() {
  return {
    singleGPU: true,
    vramGB: 0,
    thresholdGB: 4,
    handoffTimeoutSeconds: 120,
    giveUpSeconds: 300,
    waitingAlertMinutes: 2,
    manualFreeGB: 0,
    swapSeconds: 15,
    ...K.getState().hardware,
  };
}
function asComfySelected() {
  return (
    K.getState().comfy.find((s) => s.id === asProduction().settings.serverId) ||
    K.getState().comfy[0]
  );
}
async function asComfyCall(path, { signal, body, method } = {}) {
  if (asSimulationOn()) {
    if ((K.getState().simulation?.crashUntil || 0) > Date.now())
      throw Error("Simulation network unreachable: ComfyUI crashed");
    if (path === "/free")
      await asRunLog("comfy-free", "done", { simulation: true });
    if (path === "/system_stats")
      return {
        devices: [{ vram_total: 12 * 2 ** 30, vram_free: 10 * 2 ** 30 }],
      };
    if (path === "/queue") return { queue_running: [], queue_pending: [] };
    return {};
  }
  const server = asComfySelected();
  if (!server?.url)
    throw Error("Choose a ComfyUI server in the pipeline plan.");
  const r = await fetch(server.url.replace(/\/$/, "") + path, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!r.ok)
    throw Error(
      "ComfyUI " +
        path +
        " HTTP " +
        r.status +
        ". Check Connections and enable --enable-cors-header if needed.",
    );
  return r.json();
}
async function asVRAM(signal) {
  const stats = await asComfyCall("/system_stats", { signal }),
    devices = stats.devices || [],
    device =
      devices.find((d) => /cuda|gpu/i.test(d.type || d.name || "")) ||
      devices[0];
  if (!device || !Number.isFinite(device.vram_free))
    throw Error(
      "ComfyUI did not report free VRAM; review system_stats or Continue anyway explicitly.",
    );
  return {
    freeGB: device.vram_free / 2 ** 30,
    totalGB: device.vram_total / 2 ** 30,
  };
}
async function asVRAMWait(signal) {
  const until = Date.now() + asHardware().handoffTimeoutSeconds * 1000;
  let value;
  do {
    value = await asVRAM(signal);
    asPipelineRuntime.vram = value;
    asPipelineNotify();
    if (value.freeGB >= asHardware().thresholdGB) return value;
    await asPipelineDelay(1000, signal);
  } while (Date.now() < until);
  throw Error(
    "Free VRAM " +
      value.freeGB.toFixed(2) +
      " GB is below threshold " +
      asHardware().thresholdGB +
      " GB. Unload models, retry or explicitly Continue anyway.",
  );
}
async function asHardwareToComfyRaw(profile, signal) {
  const p = asLLMProfile(profile);
  if (!asHardware().singleGPU || p.keepWarm) return;
  const start = performance.now();
  let before;
  try {
    before = await asVRAM(signal);
  } catch {}
  if (p.kind === "simulation") {
    await asPipelineDelay(10, signal);
  } else if (p.kind === "ollama" || p.unloadMethod === "ollama") {
    const r = await fetch(asNativeOrigin(p) + "/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: p.model, keep_alive: 0 }),
      signal,
    });
    if (!r.ok) throw Error("Ollama unload HTTP " + r.status);
    const ps = await fetch(asNativeOrigin(p) + "/api/ps", { signal });
    if (!ps.ok)
      throw Error("Cannot verify Ollama residency: HTTP " + ps.status);
    if ((await ps.json()).models?.length)
      throw Error(
        "Ollama still has loaded models. Unload them before ComfyUI.",
      );
  } else if (p.unloadMethod === "request" && p.unloadUrl) {
    const url = p.unloadUrl.replaceAll(
        "{{model}}",
        encodeURIComponent(p.model),
      ),
      r = await fetch(url, {
        method: p.unloadHttpMethod || "POST",
        headers: {
          "content-type": "application/json",
          ...(p.apiKey ? { authorization: "Bearer " + p.apiKey } : {}),
        },
        body:
          p.unloadHttpMethod === "GET"
            ? undefined
            : (p.unloadBody || "").replaceAll("{{model}}", p.model),
        signal,
      });
    if (!r.ok) throw Error("Unload request HTTP " + r.status);
    if (!p.verifyUrl)
      throw Error(
        "Configure a residency verification URL or confirm manual unloading.",
      );
    const verify = await fetch(p.verifyUrl, {
      signal,
      headers: p.apiKey ? { authorization: "Bearer " + p.apiKey } : {},
    });
    if (!verify.ok) throw Error("Residency verification HTTP " + verify.status);
    const data = await verify.json();
    if (
      !(
        data.unloaded === true ||
        (Array.isArray(data.models) && data.models.length === 0)
      )
    )
      throw Error(
        "Residency endpoint did not confirm unloaded=true or an empty models list.",
      );
  } else if (!asPipelineRuntime.manualUnloadConfirmed)
    throw Error(
      "Unload " +
        p.model +
        " in its server, then click I have unloaded it. No unload endpoint is configured.",
    );
  await asComfyCall("/free", {
    body: { unload_models: true, free_memory: true },
    signal,
  });
  const after = await asVRAMWait(signal);
  asPipelineRuntime.manualUnloadConfirmed = false;
  await asRunLog("handoff", "done", {
    direction: "LLM → ComfyUI",
    provider: p.id,
    duration: (performance.now() - start) / 1000,
    before,
    after,
  });
}
async function asHardwareToLLM(profile, signal) {
  if (
    !asHardware().singleGPU ||
    profile.keepWarm ||
    profile.kind === "simulation"
  )
    return;
  if (
    !asPipelineRuntime.comfyUsed &&
    !K.getState().jobs.some((j) => j.provider === "comfyui") &&
    !Object.entries(asPipelineData().stages).some(
      ([i, s]) => Number(i) >= 2 && Number(i) <= 5 && s.lastRun,
    )
  )
    return;
  const until = Date.now() + asHardware().handoffTimeoutSeconds * 1000;
  for (;;) {
    const q = await asComfyCall("/queue", { signal });
    if (!(q.queue_running?.length || q.queue_pending?.length)) break;
    if (Date.now() > until)
      throw Error(
        "ComfyUI queue is not empty. Finish or cancel queued jobs before LLM analysis.",
      );
    await asPipelineDelay(1000, signal);
  }
  await asComfyCall("/free", {
    body: { unload_models: true, free_memory: true },
    signal,
  });
  const after = await asVRAMWait(signal);
  await asRunLog("handoff", "done", { direction: "ComfyUI → LLM", after });
}
function asErrorClass(error) {
  const text = String(error.message || error);
  if (error.name === "AbortError" || /cancel|stopped by/i.test(text))
    return "cancelled";
  if (/out.of.memory|cuda.*memory|\boom\b/i.test(text)) return "oom";
  if (
    /quota|disk full|notallowederror|permission|write failed|storage/i.test(
      text,
    )
  )
    return "storage";
  if (
    /missing.*(model|node)|invalid workflow|HTTP 4\d\d|permanent|not installed|choose.*workflow/i.test(
      text,
    )
  )
    return "permanent";
  if (
    /network|fetch|unreachable|timeout|\b5\d\d\b|busy|history.*failed/i.test(
      text,
    )
  )
    return "transient";
  return "permanent";
}
async function asComfyRecover(job, signal) {
  const until = Date.now() + asHardware().giveUpSeconds * 1000;
  asPipelineRuntime.waiting = true;
  asPipelineNotify();
  try {
    let attempt = 0,
      alerted = false,
      waitStarted = Date.now();
    while (Date.now() < until) {
      signal?.throwIfAborted();
      if (
        !alerted &&
        Date.now() - waitStarted > asHardware().waitingAlertMinutes * 60000
      ) {
        alerted = true;
        await asPipelineAlert(
          "Waiting for ComfyUI longer than " +
            asHardware().waitingAlertMinutes +
            " minutes",
        );
      }
      try {
        await asComfyCall("/system_stats", { signal });
        if (job?.remoteId) {
          await asResumeJob(job.id);
          return true;
        }
        return false;
      } catch (e) {
        if (asErrorClass(e) !== "transient") throw e;
        await asPipelineDelay(
          Math.min(15000, 500 * 2 ** Math.min(attempt++, 5)),
          signal,
        );
      }
    }
    throw Error(
      "Waiting for ComfyUI exceeded give-up time. Restart the server and Resume monitoring; no replacement prompt was submitted.",
    );
  } finally {
    asPipelineRuntime.waiting = false;
    asPipelineNotify();
  }
}
function asPromptLint(shot, project = G.getState().project) {
  const data = asProduction(project),
    profile = project.modelProfiles.find(
      (m) =>
        m.id ===
        (data.shots[shot.id]?.modelProfileId || data.settings.modelProfileId),
    ),
    rules = profile?.parameters || {},
    text = shot.imagePrompt + "\n" + shot.videoPrompt,
    issues = [];
  const add = (severity, message, fix) =>
    issues.push({ severity, message, fix });
  if (
    !shot.imagePrompt?.trim() ||
    !shot.videoPrompt?.trim() ||
    /\{\{|TODO|your prompt here/i.test(text)
  )
    add("error", "Empty or placeholder prompt.");
  if (rules.maxPromptLength && text.length > rules.maxPromptLength)
    add("error", "Prompt exceeds model length limit.");
  for (const token of rules.requiredTokens || [])
    if (!text.includes(token))
      add("error", "Missing required token: " + token, { append: token });
  for (const term of rules.discouragedTerms || [])
    if (text.toLowerCase().includes(term.toLowerCase()))
      add("warning", "Discouraged term: " + term);
  if (
    /static|locked.off/i.test(text) &&
    /handheld|pan(?:ning)?|dolly/i.test(text)
  )
    add("warning", "Conflicting static and moving camera instructions.");
  if (rules.englishOnly && /[\u0c00-\u0c7f]/.test(text))
    add(
      "error",
      "Telugu text in an English-only model prompt. Translate explicitly or choose a multilingual model.",
    );
  if (rules.maxClipLength && shot.duration > rules.maxClipLength)
    add(
      "info",
      "Duration needs " +
        asClipSegments(shot.duration, rules.maxClipLength).length +
        " chained segments.",
    );
  if (project.meta.stylePrefix && !text.includes(project.meta.stylePrefix))
    add("warning", "Project style prefix is missing.", {
      append: project.meta.stylePrefix,
    });
  return issues;
}
async function asStageFingerprint(index, p = G.getState().project) {
  const data = asProduction(p);
  return asFingerprint({
    stage: index,
    script: p.script,
    skills: p.skills.map((s) => ({
      id: s.id,
      body: s.body,
      roles: asRoles(s),
    })),
    selected: p.meta.skillIds,
    llm: K.getState()
      .llm.filter((p) => p.id === K.getState().activeLlmId)
      .map(({ id, model, contextWindow, maxOutputTokens }) => ({
        id,
        model,
        contextWindow,
        maxOutputTokens,
      })),
    settings: data.settings,
    shots:
      index > 1
        ? p.shots.map((s) => ({
            id: s.id,
            prompt: s.imagePrompt,
            video: s.videoPrompt,
            duration: s.duration,
            locked: s.lockedFields,
          }))
        : undefined,
  });
}
async function asPipelineStage(index, patch) {
  await asPipelineSave((data) => ({
    ...data,
    stages: { ...data.stages, [index]: { ...data.stages[index], ...patch } },
  }));
}
async function asPipelineGate(index, message, signal) {
  asPipelineRuntime.gate = { index, message };
  await asPipelineStage(index, { status: "needs review" });
  asPipelineNotify();
  await new Promise((resolve, reject) => {
    const abort = () => {
      asPipelineRuntime.continue = null;
      reject(signal.reason || new DOMException("Stopped", "AbortError"));
    };
    asPipelineRuntime.continue = () => {
      signal.removeEventListener("abort", abort);
      asPipelineRuntime.gate = null;
      asPipelineRuntime.continue = null;
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
async function asPipelineExecute(index, signal) {
  const profile = K.getState().llm.find(
      (p) => p.id === K.getState().activeLlmId,
    ),
    settings = asProduction().settings,
    data = asPipelineData();
  switch (index) {
    case 0:
      if (!profile && !data.offlineAnalysis)
        throw Error(
          "Choose an active LLM or explicitly enable Offline parser.",
        );
      await asAnalysisRun(G.getState().project, {
        profile,
        signal,
        onStatus: (text) => {
          asPipelineRuntime.current = text;
          asPipelineNotify();
        },
        sceneIds: data.selectedScenes || [],
        offline: !!data.offlineAnalysis,
      });
      if (
        data.mode === "full-auto" ||
        (data.mode === "guided" && !data.gates.includes(0))
      )
        await asAnalysisAccept();
      break;
    case 1:
      if (profile) await asHardwareToComfy(profile, signal);
      else if (!data.offlineAnalysis)
        throw Error("No active analysis provider");
      break;
    case 2:
    case 3:
    case 4: {
      const stages = { 2: "references", 3: "keyframes", 4: "videos" };
      await asProductionRun({
        ...settings,
        stageFilter:
          settings.chain && index === 3 && data.enabled[4]
            ? "continuity"
            : stages[index],
        autoAudio: false,
        autoDelivery: false,
      });
      break;
    }
    case 5:
      for (const shot of asProductionSelect(G.getState().project, settings)) {
        signal.throwIfAborted();
        if (shot.video.approvedId && settings.postWorkflowId)
          await asProductionGenerate(
            {
              stage: "post",
              kind: "video",
              target: { shotId: shot.id },
              label: "Post-process " + shot.id,
              prompt: shot.videoPrompt,
            },
            { ...settings, workflowVideo: settings.postWorkflowId },
          );
      }
      break;
    case 6:
      for (const shot of asProductionSelect(G.getState().project, settings))
        for (const version of shot.video.versions) {
          signal.throwIfAborted();
          if (!asProduction().shots[shot.id]?.qc?.[version.id])
            await asProductionQC(shot.id, version.id);
        }
      break;
    case 7:
      await asAudioAll();
      break;
    case 8: {
      const report = await asDeliveryRun(
        asDeliveryProject(G.getState().project, "delivery"),
        { scope: "delivery" },
      );
      if (!report.complete)
        throw Error(
          "Delivery incomplete. Resolve export failures and resume the Delivery stage.",
        );
      break;
    }
  }
}
async function asPipelineRun({ only, staleOnly = false } = {}) {
  if (asPipelineRuntime.active || asBatch.active)
    throw Error("A pipeline or generation batch is already running");
  const controller = new AbortController(),
    signal = controller.signal,
    projectId = Kl.getState().activeId;
  asPipelineRuntime.controller = controller;
  asPipelineRuntime.active = true;
  asPipelineRuntime.stopAfter = false;
  asPipelineNotify();
  let failure;
  const cancel = () => {
    asBatch.controller?.abort();
    asLLMStop();
    asDelivery.cancel?.();
    for (const job of K.getState().jobs.filter(
      (j) =>
        j.projectId === projectId && ["running", "queued"].includes(j.status),
    ))
      asCancelGeneration(job.id);
  };
  signal.addEventListener("abort", cancel);
  try {
    if (asPipelineData().overnight) await asOvernight(true);
    for (let index = 0; index < asStageNames.length; index++) {
      signal.throwIfAborted();
      if (Kl.getState().activeId !== projectId)
        throw Error("Project changed; pipeline stopped.");
      let state = asPipelineData(),
        prior = state.stages[index],
        fingerprint = await asStageFingerprint(index);
      if (only !== undefined && only !== index) continue;
      if (!state.enabled[index]) {
        await asPipelineStage(index, {
          status: "skipped",
          lastRun: Date.now(),
        });
        continue;
      }
      if (
        only === undefined &&
        prior?.status === "done" &&
        prior.fingerprint === fingerprint &&
        !prior.stale
      )
        continue;
      if (staleOnly && !prior?.stale && prior?.status === "done") continue;
      const started = Date.now();
      await asPipelineStage(index, {
        status: "running",
        started,
        stale: false,
        fingerprint,
        counts: { succeeded: 0, failed: 0, skipped: 0 },
      });
      asPipelineRuntime.current = asStageNames[index];
      asPipelineNotify();
      try {
        if (
          index >= 2 &&
          index <= 4 &&
          asHardware().singleGPU &&
          index === 4 &&
          !asLLMProfile(
            K.getState().llm.find((p) => p.id === K.getState().activeLlmId) ||
              {},
          ).keepWarm
        )
          await asComfyCall("/free", {
            signal,
            body: { unload_models: true, free_memory: true },
          });
        await asPipelineExecute(index, signal);
        const batch = asProduction().batch;
        if (index >= 2 && index <= 4 && batch?.failures?.length)
          throw Error(
            "Finished with " +
              batch.failures.length +
              " failures. Retry failed items or explicitly skip them.",
          );
        state = asPipelineData();
        if (index === 0 && state.mode === "manual") {
          await asPipelineStage(0, { status: "needs review" });
          break;
        }
        if (state.mode === "guided" && state.gates.includes(index)) {
          await asPipelineGate(
            index,
            "Review " + asStageNames[index] + ", then Continue.",
            signal,
          );
          if (index === 0) await asAnalysisAccept();
        }
        await asPipelineStage(index, {
          status: "done",
          fingerprint: await asStageFingerprint(index),
          lastRun: Date.now(),
          durationSeconds: (Date.now() - started) / 1000,
          stale: false,
          counts:
            index >= 2 && index <= 4
              ? {
                  succeeded: batch?.succeeded ?? batch?.done ?? 0,
                  failed: batch?.failures?.length || 0,
                  skipped: batch?.skipped || 0,
                }
              : { succeeded: 1, failed: 0, skipped: 0 },
        });
        await asRunLog(asStageNames[index], "done", {
          duration: (Date.now() - started) / 1000,
        });
      } catch (e) {
        await asPipelineStage(index, {
          status: signal.aborted ? "pending" : "failed",
          reason: asRedact(e.message),
          lastRun: Date.now(),
          counts: {
            succeeded: asBatch.succeeded || 0,
            failed: Math.max(1, asBatch.failures?.length || 0),
            skipped: asBatch.skipped || 0,
          },
        });
        throw e;
      }
      if (
        asPipelineRuntime.stopAfter ||
        only !== undefined ||
        asPipelineData().mode === "manual"
      )
        break;
    }
  } catch (e) {
    failure = e;
    await asRunLog("pipeline", "failed", { reason: e.message });
    await asPipelineAlert("Pipeline stopped: " + e.message);
    throw e;
  } finally {
    asPipelineRuntime.active = false;
    asPipelineRuntime.gate = null;
    signal.removeEventListener("abort", cancel);
    await asMorningReport(failure);
    await asOvernight(false);
    asPipelineNotify();
    if (!failure)
      await asPipelineAlert(
        "Pipeline run finished. Review the morning report and stage statuses.",
      );
  }
}
async function asOvernight(enable) {
  if (enable) {
    try {
      asPipelineRuntime.wakeLock = await navigator.wakeLock?.request("screen");
    } catch (e) {
      asPipelineRuntime.wakeWarning = e.message;
    }
    if (!navigator.wakeLock)
      asPipelineRuntime.wakeWarning = "Screen Wake Lock is not supported.";
  } else {
    await asPipelineRuntime.wakeLock?.release();
    asPipelineRuntime.wakeLock = null;
  }
  asPipelineNotify();
}
async function asPipelineAlert(message) {
  if (!asPipelineData().overnight) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)(),
      osc = ctx.createOscillator(),
      gain = ctx.createGain();
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch {}
  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  )
    new Notification("ASTRA Pipeline", { body: message });
}
async function asMorningReport(error) {
  const data = asPipelineData(),
    batch = asProduction().batch,
    report =
      "# ASTRA " +
      (asSimulationOn() ? "SIMULATION " : "") +
      "morning report\n\n" +
      new Date().toISOString() +
      "\n\n" +
      asStageNames
        .map(
          (name, i) =>
            "- " +
            name +
            ": " +
            (data.stages[i]?.status || "pending") +
            " " +
            (data.stages[i]?.reason || ""),
        )
        .join("\n") +
      "\n\nFailures:\n" +
      JSON.stringify(batch?.failures || [], null, 2) +
      "\n\nRun log and handoffs:\n" +
      asPipelineRuntime.log
        .slice(-100)
        .map((e) => JSON.stringify(e))
        .join("\n") +
      "\n\nRecommended next action: " +
      (error
        ? "Resolve " + error.message + " and resume the failed stage."
        : "Review generated takes, approvals, QC and Delivery Pack coverage.");
  await asPipelineSave((d) => ({ ...d, morningReport: asRedact(report) }));
  if (
    asPipelineData().stages[8]?.status === "done" &&
    asDelivery.handle &&
    (await asDeliveryPermission())
  ) {
    const slug = asDeliverySlug(
        G.getState().project.meta.title,
        Kl.getState().activeId,
      ),
      last = await Wo("astra-last-export:" + slug);
    if (last?.rootName)
      await asDeliveryRun(
        [
          {
            path: "07_Reports/morning_report.md",
            open: () => asRedact(report),
          },
          {
            path: "07_Reports/run_log.jsonl",
            open: () =>
              asPipelineRuntime.log.map((e) => asRedact(e)).join("\n"),
          },
        ],
        {
          destination: "folder",
          scope: "morning-report",
          rootOverride: last.rootName,
        },
      );
  }
}
async function asPipelineInit() {
  const restore = async () => {
    const id = Kl.getState().activeId;
    if (!id) return;
    const saved = await Wo("astra-analysis-review:" + id);
    if (saved && !asPipelineRuntime.active)
      asPipelineRuntime.review = {
        ...saved,
        candidate: await asMediaHydrate(saved.candidate),
      };
    const stages = asPipelineData().stages;
    if (Object.values(stages).some((s) => s.status === "running"))
      await asPipelineSave((d) => ({
        ...d,
        stages: Object.fromEntries(
          Object.entries(d.stages).map(([i, s]) => [
            i,
            s.status === "running"
              ? {
                  ...s,
                  status: "pending",
                  reason:
                    "Interrupted. Resume from saved checkpoints or prompt IDs.",
                }
              : s,
          ]),
        ),
      }));
    asPipelineNotify();
  };
  Kl.subscribe((next, previous) => {
    if (next.activeId && next.activeId !== previous.activeId)
      restore().catch((e) => console.error(e));
  });
  if (G.persist.hasHydrated()) await restore();
  else
    G.persist.onFinishHydration(() => restore().catch((e) => console.error(e)));
  asPipelineTimerInit();
  try {
    asPipelineRuntime.log = (await Wo("astra-run-log")) || [];
  } catch {}
  let timer;
  G.subscribe((next, previous) => {
    if (
      asPipelineRuntime.applying ||
      !next.hydrated ||
      next.project === previous.project ||
      next.project.schemaVersion < 4 ||
      !next.project.pipeline ||
      next.project.pipeline !== previous.project.pipeline
    )
      return;
    const changed = next.project.shots.filter((s) => {
      const old = previous.project.shots.find((v) => v.id === s.id);
      return old && asTargetRevision(old) !== asTargetRevision(s);
    });
    const assets = ["characters", "environments", "props", "costumes"].flatMap(
      (kind) =>
        next.project[kind]
          .filter((a) => {
            const old = previous.project[kind].find((v) => v.id === a.id);
            return old && asTargetRevision(old) !== asTargetRevision(a);
          })
          .map((a) => a.id),
    );
    if (changed.length && !asPipelineRuntime.active)
      queueMicrotask(() =>
        asProductionSave((d) => ({
          ...d,
          shots: {
            ...d.shots,
            ...Object.fromEntries(
              changed.map((s) => [
                s.id,
                { ...d.shots[s.id], userEdited: true },
              ]),
            ),
          },
        })).catch(() => {}),
      );
    if (assets.length && !asPipelineRuntime.active)
      queueMicrotask(() =>
        asPipelineSave((d) => ({
          ...d,
          manualAssets: [...new Set([...(d.manualAssets || []), ...assets])],
        })).catch(() => {}),
      );
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const p = G.getState().project,
          data = asPipelineData(p);
        for (const [i, stage] of Object.entries(data.stages)) {
          if (
            stage.status === "done" &&
            stage.fingerprint !== (await asStageFingerprint(Number(i), p))
          )
            await asPipelineStage(Number(i), { stale: true });
        }
      } catch (e) {
        console.error("Pipeline staleness check failed", e);
      }
    }, 300);
  });
}

async function asHardwareToComfy(profile, signal) {
  for (;;) {
    try {
      return await asHardwareToComfyRaw(profile, signal);
    } catch (e) {
      await asRunLog("handoff", "blocked", { reason: e.message });
      asPipelineRuntime.handoffError = e.message;
      asPipelineNotify();
      if (!asPipelineRuntime.active || signal?.aborted) throw e;
      const choice = await new Promise((resolve, reject) => {
        const abort = () => {
          asPipelineRuntime.handoffChoice = null;
          reject(signal.reason || new DOMException("Stopped", "AbortError"));
        };
        asPipelineRuntime.handoffChoice = (value) => {
          signal?.removeEventListener("abort", abort);
          asPipelineRuntime.handoffChoice = null;
          resolve(value);
        };
        signal?.addEventListener("abort", abort, { once: true });
      });
      asPipelineRuntime.handoffError = null;
      if (choice === "continue") {
        await asRunLog("handoff", "explicit-override", {
          reason: "User chose Continue anyway",
        });
        return;
      }
      if (choice === "stop")
        throw new DOMException("Stopped at hardware handoff", "AbortError");
    }
  }
}

async function asExecuteProductionTask(task, settings, signal) {
  let transient = 0,
    oom = false,
    retry = false;
  for (;;) {
    signal.throwIfAborted();
    await asBatchCheckpoint();
    try {
      return await asProductionGenerate(
        { ...task, retry },
        { ...settings, seed: retry ? "" : settings.seed },
      );
    } catch (e) {
      const kind = asErrorClass(e);
      await asRunLog(task.stage, "failed", {
        classification: kind,
        reason: e.message,
        task: task.label,
      });
      if (kind === "cancelled" || signal.aborted) throw e;
      if (kind === "storage")
        throw Error(
          "Blocking storage failure: " +
            e.message +
            "; resolve disk/quota permissions and resume.",
        );
      if (kind === "permanent") throw e;
      if (kind === "oom") {
        if (oom)
          throw Error(
            "Needs lower settings after out-of-memory retry: " + e.message,
          );
        oom = true;
        await asComfyCall("/free", {
          body: { unload_models: true, free_memory: true },
          signal,
        });
        retry = true;
        continue;
      }
      if (asSimulationOn() && /unreachable/i.test(e.message)) {
        await asComfyRecover(null, signal);
        retry = true;
        continue;
      }
      const job = K.getState().jobs.find(
        (j) =>
          j.target?.shotId === task.target.shotId &&
          j.projectId === Kl.getState().activeId &&
          j.remoteId &&
          j.status === "failed",
      );
      if (
        job &&
        /unreachable|network|fetch|history|timed out|timeout/i.test(e.message)
      ) {
        await asComfyRecover(job, signal);
        return job;
      }
      if (++transient >= Math.max(1, settings.attempts)) throw e;
      asBatch.current = task.label + " retry " + (transient + 1);
      asBatchNotify();
      await asPipelineDelay(
        Math.min(30000, 1000 * 2 ** (transient - 1)),
        signal,
      );
      retry = true;
    }
  }
}

async function asRetryFailure(index) {
  if (asBatch.active || asPipelineRuntime.active)
    throw Error("Stop the active run before retrying one item.");
  const item = asProduction().batch?.failures[index];
  if (!item?.taskSpec)
    throw Error(
      "This older failure has no saved task. Run its failed stage again.",
    );
  const task = { ...item.taskSpec },
    shot = G.getState().project.shots.find((s) => s.id === task.target.shotId);
  if (shot)
    task.prompt = task.kind === "image" ? shot.imagePrompt : shot.videoPrompt;
  Object.assign(asBatch, {
    active: true,
    paused: false,
    controller: new AbortController(),
    failures: [],
    total: 1,
    done: 0,
    succeeded: 0,
    skipped: 0,
  });
  try {
    await asExecuteProductionTask(
      task,
      asProduction().settings,
      asBatch.controller.signal,
    );
    await asProductionSave((d) => ({
      ...d,
      batch: {
        ...d.batch,
        failures: d.batch.failures.filter((_, i) => i !== index),
        succeeded: (d.batch.succeeded || 0) + 1,
      },
    }));
  } finally {
    asBatch.active = false;
    asBatchNotify();
  }
}
function asPipelineSchema() {
  return wc({
    mode: Tc(["manual", "guided", "full-auto"]).optional(),
    gates: Cc(xc().int().min(0).max(8)).optional(),
    enabled: Cc(Sc()).optional(),
    stages: wc({})
      .catchall(
        wc({
          status: Tc([
            "pending",
            "running",
            "needs review",
            "done",
            "failed",
            "skipped",
          ]).optional(),
          fingerprint: U().optional(),
          stale: Sc().optional(),
          counts: wc({
            succeeded: xc().min(0).optional(),
            failed: xc().min(0).optional(),
            skipped: xc().min(0).optional(),
          })
            .passthrough()
            .optional(),
        }).passthrough(),
      )
      .optional(),
  })
    .passthrough()
    .optional();
}

const asPipelineJSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["meta"],
  properties: {
    vision: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        statement: { type: "string" },
        theme: { type: "string" },
        centralDramaticQuestion: { type: "string" },
        visualMetaphor: { type: "string" },
        centralImage: { type: "string" },
        emotionalArc: { type: "array", items: { type: "string" } },
        motifs: { type: "array", items: { type: "string" } },
        soundMusicIntent: { type: "string" },
      },
    },
    lookBible: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        cameraLanguage: { type: "string" },
        lensLanguage: { type: "string" },
        movementLanguage: { type: "string" },
        blockingLanguage: { type: "string" },
        lightingLanguage: { type: "string" },
        colorLanguage: { type: "string" },
        textureLanguage: { type: "string" },
        pacingLanguage: { type: "string" },
        performanceLanguage: { type: "string" },
        styleBlock: { type: "string" },
        negativeBlock: { type: "string" },
      },
    },
    sequences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          order: { anyOf: [{ type: "number" }, { type: "null" }] },
          act: { type: "string" },
          sceneIds: { type: "array", items: { type: "string" } },
          dramaticGoal: { type: "string" },
          tensionCurve: { type: "array", items: { type: "number" } },
          palette: { type: "string" },
          soundMusicIntent: { type: "string" },
          editingIntent: { type: "string" },
          plannedDurationS: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
      },
    },
    continuityEvents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          id: { type: "string" },
          sceneId: { type: "string" },
          shotId: { type: "string" },
          assetType: { type: "string" },
          assetId: { type: "string" },
          category: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          trigger: { type: "string" },
          verificationStatus: { type: "string" },
        },
      },
    },
    modelProfiles: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [],
        properties: {
          id: { type: "string" },
          provider: { type: "string" },
          model: { type: "string" },
          version: { type: "string" },
          modality: { type: "string" },
          mode: { type: "string" },
          parameters: {
            type: "object",
            additionalProperties: true,
            required: [],
            properties: {},
          },
          referencePolicy: { type: "string" },
          knownLimits: { type: "string" },
        },
      },
    },
    schemaVersion: { const: 4 },
    meta: {
      type: "object",
      additionalProperties: false,
      required: ["title"],
      properties: {
        title: { type: "string" },
        genres: { type: "string" },
        expectedLengthMin: { type: "number", exclusiveMinimum: 0 },
        logline: { type: "string" },
        synopsis: { type: "string" },
        directingStyle: { type: "string" },
        cinematographyStyle: { type: "string" },
        editingStyle: { type: "string" },
        languages: { type: "string" },
        aspectRatio: { type: "string" },
        frameRate: { type: "number", exclusiveMinimum: 0 },
        stylePrefix: { type: "string" },
        styleSuffix: { type: "string" },
        styleNegative: { type: "string" },
        skillIds: { type: "array", items: { type: "string" } },
        glossary: { type: "string" },
        thumbnail: { type: "string" },
        bannerImage: { type: "string" },
        bannerPosition: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: { x: { type: "number" }, y: { type: "number" } },
        },
        thumbView: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            zoom: { type: "number" },
            fit: { type: "string", enum: ["cover", "contain"] },
          },
        },
      },
    },
    script: { type: "string" },
    scriptElements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "text"],
        properties: {
          type: { type: "string" },
          text: { type: "string" },
          sceneNumber: { type: "string" },
          alignment: { type: "string" },
          startsNewPage: { type: "boolean" },
          dualGroup: { type: "string" },
          dual: { type: "boolean" },
          runs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text"],
              properties: {
                text: { type: "string" },
                bold: { type: "boolean" },
                italic: { type: "boolean" },
                underline: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    scriptSource: { type: "string" },
    scriptVersions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "createdAt", "text"],
        properties: {
          id: { type: "string" },
          createdAt: { type: "number" },
          text: { type: "string" },
          elements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "text"],
              properties: {
                type: { type: "string" },
                text: { type: "string" },
                sceneNumber: { type: "string" },
                alignment: { type: "string" },
                startsNewPage: { type: "boolean" },
                dualGroup: { type: "string" },
                dual: { type: "boolean" },
                runs: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["text"],
                    properties: {
                      text: { type: "string" },
                      bold: { type: "boolean" },
                      italic: { type: "boolean" },
                      underline: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
          source: { type: "string" },
        },
      },
    },
    characters: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          idBlock: { type: "string" },
          gestureSignature: { type: "string" },
          stateVariants: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                sceneIds: { type: "array", items: { type: "string" } },
                shotIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          name: { type: "string" },
          sceneIds: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          prompt: { type: "string" },
          negativePrompt: { type: "string" },
          refs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "url"],
              properties: {
                id: { type: "string" },
                url: { type: "string" },
                label: { type: "string" },
                locked: { type: "boolean" },
              },
            },
          },
          status: {
            type: "string",
            enum: ["draft", "prompted", "generated", "approved"],
          },
          notes: { type: "string" },
          angles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                prompt: { type: "string" },
                image: { type: "string" },
              },
            },
          },
          aliases: { type: "string" },
          role: { type: "string" },
          age: { type: "string" },
          gender: { type: "string" },
          look: { type: "string" },
          personality: { type: "string" },
          arc: { type: "string" },
          seed: { type: "string" },
        },
      },
    },
    environments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          locBlock: { type: "string" },
          geographyMap: { type: "string" },
          sunDirection: { type: "string" },
          lightingVariants: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                sceneIds: { type: "array", items: { type: "string" } },
                shotIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          name: { type: "string" },
          sceneIds: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          prompt: { type: "string" },
          negativePrompt: { type: "string" },
          refs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "url"],
              properties: {
                id: { type: "string" },
                url: { type: "string" },
                label: { type: "string" },
                locked: { type: "boolean" },
              },
            },
          },
          status: {
            type: "string",
            enum: ["draft", "prompted", "generated", "approved"],
          },
          notes: { type: "string" },
          intExt: { type: "string" },
          time: { type: "string" },
          mood: { type: "string" },
          palette: { type: "string" },
          angles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                prompt: { type: "string" },
                image: { type: "string" },
              },
            },
          },
        },
      },
    },
    props: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          propBlock: { type: "string" },
          dimensions: { type: "string" },
          physicalState: { type: "string" },
          stateVariants: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                sceneIds: { type: "array", items: { type: "string" } },
                shotIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          name: { type: "string" },
          sceneIds: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          prompt: { type: "string" },
          negativePrompt: { type: "string" },
          refs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "url"],
              properties: {
                id: { type: "string" },
                url: { type: "string" },
                label: { type: "string" },
                locked: { type: "boolean" },
              },
            },
          },
          status: {
            type: "string",
            enum: ["draft", "prompted", "generated", "approved"],
          },
          notes: { type: "string" },
          angles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                prompt: { type: "string" },
                image: { type: "string" },
              },
            },
          },
          material: { type: "string" },
          significance: { type: "string" },
        },
      },
    },
    costumes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          wardrobeBlock: { type: "string" },
          wearState: { type: "string" },
          wardrobeChanges: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                description: { type: "string" },
                sceneIds: { type: "array", items: { type: "string" } },
                shotIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          name: { type: "string" },
          sceneIds: { type: "array", items: { type: "string" } },
          description: { type: "string" },
          prompt: { type: "string" },
          negativePrompt: { type: "string" },
          refs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "url"],
              properties: {
                id: { type: "string" },
                url: { type: "string" },
                label: { type: "string" },
                locked: { type: "boolean" },
              },
            },
          },
          status: {
            type: "string",
            enum: ["draft", "prompted", "generated", "approved"],
          },
          notes: { type: "string" },
          angles: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "name"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                prompt: { type: "string" },
                image: { type: "string" },
              },
            },
          },
          characterId: { type: "string" },
        },
      },
    },
    scenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "number", "slug"],
        properties: {
          sequenceId: { type: "string" },
          scriptPages: { type: "string" },
          estimatedScreenTimeS: {
            anyOf: [{ type: "number" }, { type: "null" }],
          },
          storyFunction: { type: "string" },
          conflict: { type: "string" },
          subtext: { type: "string" },
          sceneTurn: { type: "string" },
          emotionalStart: { type: "string" },
          emotionalEnd: { type: "string" },
          tensionScore: { anyOf: [{ type: "number" }, { type: "null" }] },
          directorIntent: { type: "string" },
          weather: { type: "string" },
          sunDirection: { type: "string" },
          breakdown: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              speakingCast: { type: "array", items: { type: "string" } },
              nonSpeakingCast: { type: "array", items: { type: "string" } },
              extras: { type: "array", items: { type: "string" } },
              props: { type: "array", items: { type: "string" } },
              costumes: { type: "array", items: { type: "string" } },
              vehicles: { type: "array", items: { type: "string" } },
              animals: { type: "array", items: { type: "string" } },
              setDressing: { type: "array", items: { type: "string" } },
              makeupHair: { type: "array", items: { type: "string" } },
              stunts: { type: "array", items: { type: "string" } },
              practicalSfx: { type: "array", items: { type: "string" } },
              vfx: { type: "array", items: { type: "string" } },
              specialEquipment: { type: "array", items: { type: "string" } },
              lightingSetup: { type: "string" },
              soundMusic: { type: "string" },
              productionConstraints: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          number: { type: "number" },
          heroImage: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["shotId", "versionId"],
                properties: {
                  shotId: { type: "string" },
                  versionId: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          heroVideo: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["shotId", "versionId"],
                properties: {
                  shotId: { type: "string" },
                  versionId: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          scriptNumber: { type: "string" },
          slug: { type: "string" },
          intExt: { type: "string" },
          location: { type: "string" },
          time: { type: "string" },
          mood: { type: "string" },
          summary: { type: "string" },
          text: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high"] },
          productionStage: { type: "string" },
          productionNotes: { type: "string" },
        },
      },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "sceneId", "order"],
        properties: {
          shotCode: { type: "string" },
          sequenceId: { type: "string" },
          purpose: { type: "string" },
          emotion: { type: "string" },
          coverageRole: { type: "string" },
          cameraBody: { type: "string" },
          captureFormat: { type: "string" },
          lensFamily: { type: "string" },
          lensMm: { anyOf: [{ type: "number" }, { type: "null" }] },
          aperture: { type: "string" },
          cameraHeightM: { anyOf: [{ type: "number" }, { type: "null" }] },
          cameraSupport: { type: "string" },
          cameraMoveStart: { type: "string" },
          cameraMoveEnd: { type: "string" },
          blocking: { type: "string" },
          screenDirection: { type: "string" },
          axisOfAction: { type: "string" },
          eyelineNotes: { type: "string" },
          composition: { type: "string" },
          focusPlan: { type: "string" },
          startFrameDescription: { type: "string" },
          endFrameDescription: { type: "string" },
          captureFps: { anyOf: [{ type: "number" }, { type: "null" }] },
          shutterAngleDeg: { anyOf: [{ type: "number" }, { type: "null" }] },
          imageAltPrompt: { type: "string" },
          videoAltPrompt: { type: "string" },
          videoNegativePrompt: { type: "string" },
          continuityFlags: { type: "array", items: { type: "string" } },
          referenceSelections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                assetId: { type: "string" },
                referenceId: { type: "string" },
                angleId: { type: "string" },
                role: { type: "string" },
              },
            },
          },
          seedNotes: { type: "string" },
          qa: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              status: { type: "string" },
              technicalNotes: { type: "string" },
              creativeNotes: { type: "string" },
              continuityNotes: { type: "string" },
              reviewer: { type: "string" },
            },
          },
          modelOverrides: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                modelProfileId: { type: "string" },
                prompt: { type: "string" },
                negativePrompt: { type: "string" },
                editInstructions: { type: "string" },
                parameters: {
                  type: "object",
                  additionalProperties: true,
                  required: [],
                  properties: {},
                },
                referenceIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          sceneId: { type: "string" },
          angleSelections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["assetId", "angleId"],
              properties: {
                assetId: { type: "string" },
                angleId: { type: "string" },
              },
            },
          },
          order: { type: "number" },
          type: { type: "string" },
          angle: { type: "string" },
          movement: { type: "string" },
          lens: { type: "string" },
          duration: { type: "number", exclusiveMinimum: 0 },
          action: { type: "string" },
          dialogue: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["character", "line"],
              properties: {
                character: { type: "string" },
                line: { type: "string" },
                lang: { type: "string", enum: ["en", "te"] },
              },
            },
          },
          characterIds: { type: "array", items: { type: "string" } },
          environmentId: { type: "string" },
          environmentAngleId: { type: "string" },
          propIds: { type: "array", items: { type: "string" } },
          costumeIds: { type: "array", items: { type: "string" } },
          lighting: { type: "string" },
          colorPalette: { type: "string" },
          imagePrompt: { type: "string" },
          negativePrompt: { type: "string" },
          videoPrompt: { type: "string" },
          transition: { type: "string" },
          soundCue: { type: "string" },
          image: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              versions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "url"],
                  properties: {
                    modelProfileId: { type: "string" },
                    seed: { type: "string" },
                    promptHash: { type: "string" },
                    referenceIds: { type: "array", items: { type: "string" } },
                    durationS: {
                      anyOf: [{ type: "number" }, { type: "null" }],
                    },
                    fps: { anyOf: [{ type: "number" }, { type: "null" }] },
                    width: { anyOf: [{ type: "number" }, { type: "null" }] },
                    height: { anyOf: [{ type: "number" }, { type: "null" }] },
                    qaStatus: { type: "string" },
                    parentVersionId: { type: "string" },
                    id: { type: "string" },
                    url: { type: "string" },
                    createdAt: { type: "number" },
                    source: { type: "string" },
                  },
                },
              },
              approvedId: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          video: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              versions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "url"],
                  properties: {
                    modelProfileId: { type: "string" },
                    seed: { type: "string" },
                    promptHash: { type: "string" },
                    referenceIds: { type: "array", items: { type: "string" } },
                    durationS: {
                      anyOf: [{ type: "number" }, { type: "null" }],
                    },
                    fps: { anyOf: [{ type: "number" }, { type: "null" }] },
                    width: { anyOf: [{ type: "number" }, { type: "null" }] },
                    height: { anyOf: [{ type: "number" }, { type: "null" }] },
                    qaStatus: { type: "string" },
                    parentVersionId: { type: "string" },
                    id: { type: "string" },
                    url: { type: "string" },
                    createdAt: { type: "number" },
                    source: { type: "string" },
                  },
                },
              },
              approvedId: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          stage: {
            type: "string",
            enum: [
              "planned",
              "prompted",
              "image",
              "image_approved",
              "video",
              "video_approved",
              "locked",
            ],
          },
          notes: { type: "string" },
          lockedFields: { type: "array", items: { type: "string" } },
        },
      },
    },
    archivedScenes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "number", "slug"],
        properties: {
          sequenceId: { type: "string" },
          scriptPages: { type: "string" },
          estimatedScreenTimeS: {
            anyOf: [{ type: "number" }, { type: "null" }],
          },
          storyFunction: { type: "string" },
          conflict: { type: "string" },
          subtext: { type: "string" },
          sceneTurn: { type: "string" },
          emotionalStart: { type: "string" },
          emotionalEnd: { type: "string" },
          tensionScore: { anyOf: [{ type: "number" }, { type: "null" }] },
          directorIntent: { type: "string" },
          weather: { type: "string" },
          sunDirection: { type: "string" },
          breakdown: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              speakingCast: { type: "array", items: { type: "string" } },
              nonSpeakingCast: { type: "array", items: { type: "string" } },
              extras: { type: "array", items: { type: "string" } },
              props: { type: "array", items: { type: "string" } },
              costumes: { type: "array", items: { type: "string" } },
              vehicles: { type: "array", items: { type: "string" } },
              animals: { type: "array", items: { type: "string" } },
              setDressing: { type: "array", items: { type: "string" } },
              makeupHair: { type: "array", items: { type: "string" } },
              stunts: { type: "array", items: { type: "string" } },
              practicalSfx: { type: "array", items: { type: "string" } },
              vfx: { type: "array", items: { type: "string" } },
              specialEquipment: { type: "array", items: { type: "string" } },
              lightingSetup: { type: "string" },
              soundMusic: { type: "string" },
              productionConstraints: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          number: { type: "number" },
          heroImage: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["shotId", "versionId"],
                properties: {
                  shotId: { type: "string" },
                  versionId: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          heroVideo: {
            anyOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["shotId", "versionId"],
                properties: {
                  shotId: { type: "string" },
                  versionId: { type: "string" },
                },
              },
              { type: "null" },
            ],
          },
          scriptNumber: { type: "string" },
          slug: { type: "string" },
          intExt: { type: "string" },
          location: { type: "string" },
          time: { type: "string" },
          mood: { type: "string" },
          summary: { type: "string" },
          text: { type: "string" },
          priority: { type: "string", enum: ["low", "normal", "high"] },
          productionStage: { type: "string" },
          productionNotes: { type: "string" },
        },
      },
    },
    archivedShots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "sceneId", "order"],
        properties: {
          shotCode: { type: "string" },
          sequenceId: { type: "string" },
          purpose: { type: "string" },
          emotion: { type: "string" },
          coverageRole: { type: "string" },
          cameraBody: { type: "string" },
          captureFormat: { type: "string" },
          lensFamily: { type: "string" },
          lensMm: { anyOf: [{ type: "number" }, { type: "null" }] },
          aperture: { type: "string" },
          cameraHeightM: { anyOf: [{ type: "number" }, { type: "null" }] },
          cameraSupport: { type: "string" },
          cameraMoveStart: { type: "string" },
          cameraMoveEnd: { type: "string" },
          blocking: { type: "string" },
          screenDirection: { type: "string" },
          axisOfAction: { type: "string" },
          eyelineNotes: { type: "string" },
          composition: { type: "string" },
          focusPlan: { type: "string" },
          startFrameDescription: { type: "string" },
          endFrameDescription: { type: "string" },
          captureFps: { anyOf: [{ type: "number" }, { type: "null" }] },
          shutterAngleDeg: { anyOf: [{ type: "number" }, { type: "null" }] },
          imageAltPrompt: { type: "string" },
          videoAltPrompt: { type: "string" },
          videoNegativePrompt: { type: "string" },
          continuityFlags: { type: "array", items: { type: "string" } },
          referenceSelections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                assetId: { type: "string" },
                referenceId: { type: "string" },
                angleId: { type: "string" },
                role: { type: "string" },
              },
            },
          },
          seedNotes: { type: "string" },
          qa: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              status: { type: "string" },
              technicalNotes: { type: "string" },
              creativeNotes: { type: "string" },
              continuityNotes: { type: "string" },
              reviewer: { type: "string" },
            },
          },
          modelOverrides: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [],
              properties: {
                modelProfileId: { type: "string" },
                prompt: { type: "string" },
                negativePrompt: { type: "string" },
                editInstructions: { type: "string" },
                parameters: {
                  type: "object",
                  additionalProperties: true,
                  required: [],
                  properties: {},
                },
                referenceIds: { type: "array", items: { type: "string" } },
              },
            },
          },
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          sceneId: { type: "string" },
          angleSelections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["assetId", "angleId"],
              properties: {
                assetId: { type: "string" },
                angleId: { type: "string" },
              },
            },
          },
          order: { type: "number" },
          type: { type: "string" },
          angle: { type: "string" },
          movement: { type: "string" },
          lens: { type: "string" },
          duration: { type: "number" },
          action: { type: "string" },
          dialogue: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["character", "line"],
              properties: {
                character: { type: "string" },
                line: { type: "string" },
                lang: { type: "string", enum: ["en", "te"] },
              },
            },
          },
          characterIds: { type: "array", items: { type: "string" } },
          environmentId: { type: "string" },
          environmentAngleId: { type: "string" },
          propIds: { type: "array", items: { type: "string" } },
          costumeIds: { type: "array", items: { type: "string" } },
          lighting: { type: "string" },
          colorPalette: { type: "string" },
          imagePrompt: { type: "string" },
          negativePrompt: { type: "string" },
          videoPrompt: { type: "string" },
          transition: { type: "string" },
          soundCue: { type: "string" },
          image: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              versions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "url"],
                  properties: {
                    modelProfileId: { type: "string" },
                    seed: { type: "string" },
                    promptHash: { type: "string" },
                    referenceIds: { type: "array", items: { type: "string" } },
                    durationS: {
                      anyOf: [{ type: "number" }, { type: "null" }],
                    },
                    fps: { anyOf: [{ type: "number" }, { type: "null" }] },
                    width: { anyOf: [{ type: "number" }, { type: "null" }] },
                    height: { anyOf: [{ type: "number" }, { type: "null" }] },
                    qaStatus: { type: "string" },
                    parentVersionId: { type: "string" },
                    id: { type: "string" },
                    url: { type: "string" },
                    createdAt: { type: "number" },
                    source: { type: "string" },
                  },
                },
              },
              approvedId: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          video: {
            type: "object",
            additionalProperties: false,
            required: [],
            properties: {
              versions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["id", "url"],
                  properties: {
                    modelProfileId: { type: "string" },
                    seed: { type: "string" },
                    promptHash: { type: "string" },
                    referenceIds: { type: "array", items: { type: "string" } },
                    durationS: {
                      anyOf: [{ type: "number" }, { type: "null" }],
                    },
                    fps: { anyOf: [{ type: "number" }, { type: "null" }] },
                    width: { anyOf: [{ type: "number" }, { type: "null" }] },
                    height: { anyOf: [{ type: "number" }, { type: "null" }] },
                    qaStatus: { type: "string" },
                    parentVersionId: { type: "string" },
                    id: { type: "string" },
                    url: { type: "string" },
                    createdAt: { type: "number" },
                    source: { type: "string" },
                  },
                },
              },
              approvedId: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
          },
          stage: {
            type: "string",
            enum: [
              "planned",
              "prompted",
              "image",
              "image_approved",
              "video",
              "video_approved",
              "locked",
            ],
          },
          notes: { type: "string" },
          lockedFields: { type: "array", items: { type: "string" } },
        },
      },
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name"],
        properties: {
          id: { type: "string" },
          createdAt: { type: "number" },
          updatedAt: { type: "number" },
          type: {
            type: "string",
            enum: [
              "direction",
              "cinematography",
              "editing",
              "color",
              "sound",
              "custom",
            ],
          },
          name: { type: "string" },
          version: { type: "string" },
          tags: { type: "string" },
          body: { type: "string" },
          roles: {
            type: "array",
            items: {
              enum: [
                "analysis",
                "bible",
                "direction",
                "cinematography",
                "editing",
                "sound",
                "prompt-image",
                "prompt-video",
                "continuity",
              ],
            },
          },
        },
      },
    },
    production: {
      type: "object",
      additionalProperties: true,
      properties: {
        settings: {
          type: "object",
          properties: {
            takes: { type: "integer", minimum: 1, maximum: 8 },
            attempts: { type: "integer", minimum: 1, maximum: 10 },
          },
          additionalProperties: true,
        },
        shots: { type: "object", additionalProperties: { type: "object" } },
        voices: { type: "object", additionalProperties: { type: "object" } },
        audio: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "url"],
            properties: { id: { type: "string" }, url: { type: "string" } },
            additionalProperties: true,
          },
        },
        cues: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "url"],
            properties: { id: { type: "string" }, url: { type: "string" } },
            additionalProperties: true,
          },
        },
      },
    },
    pipeline: {
      type: "object",
      properties: {
        mode: { enum: ["manual", "guided", "full-auto"] },
        enabled: { type: "array", items: { type: "boolean" } },
        gates: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 8 },
        },
        stages: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              status: {
                enum: [
                  "pending",
                  "running",
                  "needs review",
                  "done",
                  "failed",
                  "skipped",
                ],
              },
              fingerprint: { type: "string" },
              stale: { type: "boolean" },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
  },
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ASTRA Studio pipeline project v4",
  description:
    "Version 4 adds persistent orchestrator state and skill roles. Legacy v1/v2/v3 import remains supported.",
};
