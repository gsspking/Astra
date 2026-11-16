/* Local production pipeline and editor delivery. All provider requests use Connections. */
const asProductionDefaults = {
  takes: 2,
  attempts: 3,
  chain: false,
  autoAudio: false,
  autoDelivery: false,
  scope: "missing",
  sceneIds: [],
  workflowImage: "",
  workflowVideo: "",
  serverId: "",
  ttsApiId: "",
  lipSyncApiId: "",
  postWorkflowId: "",
  qcTolerance: 0.2,
  modelProfileId: "",
  seed: "",
  lora: "",
  negative: "",
  scratchAudio: false,
};
function asProduction(project = G.getState().project) {
  return {
    settings: { ...asProductionDefaults, ...project.production?.settings },
    shots: project.production?.shots || {},
    voices: project.production?.voices || {},
    audio: project.production?.audio || [],
    cues: project.production?.cues || [],
    timings: project.production?.timings || {},
    revision: project.production?.revision || null,
    batch: project.production?.batch || null,
  };
}
let asProductionSaveQueue = Promise.resolve();
async function asProductionSave(change, label = "production") {
  const id = Kl.getState().activeId;
  const result = asProductionSaveQueue
    .catch(() => {})
    .then(async () => {
      if (Kl.getState().activeId !== id) throw Error("Active project changed");
      const original = G.getState().project;
      if (original.schemaVersion < 3) {
        await asWriteStored("astra-pre-v3-" + id, original);
        G.getState().snapshot("Before production schema v3 migration");
      }
      G.getState().set(
        (p) => ({
          ...p,
          schemaVersion: Math.max(3, p.schemaVersion || 3),
          production: change(asProduction(p)),
        }),
        label,
      );
      const state = G.getState();
      await asPersistProject(
        "filmforge-project",
        JSON.stringify({
          state: { project: state.project, snapshots: state.snapshots },
          version: 0,
        }),
      );
    });
  asProductionSaveQueue = result;
  return result;
}

function asProductionCode(project, shot) {
  const scene = project.scenes.find((s) => s.id === shot.sceneId);
  return (
    "S" +
    String(scene?.number || 1).padStart(3, "0") +
    "_SH" +
    String(shot.order).padStart(3, "0")
  );
}
function asProductionOrdered(p) {
  const order = new Map(
    [...p.scenes].sort((a, b) => a.number - b.number).map((s, i) => [s.id, i]),
  );
  return [...p.shots].sort(
    (a, b) =>
      (order.get(a.sceneId) ?? 1e6) - (order.get(b.sceneId) ?? 1e6) ||
      a.order - b.order ||
      a.id.localeCompare(b.id),
  );
}
function asProductionSelect(p, settings) {
  return asProductionOrdered(p).filter(
    (s) =>
      !s.lockedFields?.includes("*") &&
      !asProduction(p).shots[s.id]?.locked &&
      (settings.scope !== "selected" ||
        settings.sceneIds.includes(s.sceneId)) &&
      (settings.scope !== "qc" ||
        Object.values(asProduction(p).shots[s.id]?.qc || {}).some(
          (q) => q.flags?.length,
        )) &&
      (settings.scope !== "failed" ||
        asProduction(p).batch?.failures?.some((f) => f.shotId === s.id)) &&
      (settings.scope !== "stale" || asPipelineData(p).stages[4]?.stale),
  );
}
const asServerSlots = new Map();
async function asServerAcquire(id, signal) {
  const limit = Math.max(
    1,
    Number(K.getState().comfy.find((s) => s.id === id)?.concurrency || 1),
  );
  while ((asServerSlots.get(id) || 0) >= limit) {
    signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 100));
  }
  asServerSlots.set(id, (asServerSlots.get(id) || 0) + 1);
  return () =>
    asServerSlots.set(id, Math.max(0, (asServerSlots.get(id) || 1) - 1));
}
function asClipSegments(duration, max = Infinity) {
  if (!Number.isFinite(duration) || duration <= 0)
    throw Error("Shot duration must be positive");
  if (!(max > 0)) throw Error("Model maximum clip length must be positive");
  const result = [];
  let offset = 0;
  while (offset < duration) {
    const length = Math.min(max, duration - offset);
    result.push({ index: result.length, start: offset, duration: length });
    offset += length;
  }
  return result;
}
function asProductionPlan(p, settings = asProduction(p).settings) {
  const state = asProduction(p),
    tasks = [];
  for (const kind of ["characters", "environments", "props", "costumes"])
    for (const asset of p[kind])
      if (
        !asset.refs.length &&
        (!settings.sceneIds.length ||
          asset.sceneIds.some((id) => settings.sceneIds.includes(id)))
      )
        tasks.push({
          stage: "references",
          kind: "image",
          target: { asset: { kind, id: asset.id } },
          label: asset.name,
          prompt: asset.prompt,
        });
  for (const shot of asProductionSelect(p, settings)) {
    const profile = p.modelProfiles.find(
        (m) =>
          m.id ===
          (state.shots[shot.id]?.modelProfileId || settings.modelProfileId),
      ),
      max = Number(profile?.parameters?.maxClipLength) || Infinity,
      segments = asClipSegments(shot.duration, max);
    if (
      !shot.image.versions.length ||
      settings.regenerateScenes?.includes(shot.sceneId)
    )
      tasks.push({
        stage: "keyframes",
        kind: "image",
        target: { shotId: shot.id },
        label: asProductionCode(p, shot),
        prompt: shot.imagePrompt || rl(p, shot),
      });
    if (
      !shot.video.approvedId ||
      settings.regenerateScenes?.includes(shot.sceneId)
    ) {
      const segmented = segments.length > 1,
        records = state.shots[shot.id]?.segments || [],
        force = settings.regenerateScenes?.includes(shot.sceneId),
        takeOffset = force ? Math.max(0, ...records.map((r) => r.take)) : 0;
      const existing =
        force || segmented
          ? 0
          : shot.video.versions.filter(
              (v) => !state.shots[shot.id]?.rejected?.includes(v.id),
            ).length;
      for (
        let take = existing;
        take < (state.shots[shot.id]?.takes || settings.takes);
        take++
      )
        for (const segment of segments) {
          if (
            !force &&
            segmented &&
            records.some(
              (r) =>
                r.take === take + 1 &&
                r.index === segment.index &&
                shot.video.versions.some(
                  (v) =>
                    v.id === r.versionId &&
                    !state.shots[shot.id]?.rejected?.includes(v.id),
                ),
            )
          )
            continue;
          tasks.push({
            stage: "videos",
            kind: "video",
            target: { shotId: shot.id },
            label:
              asProductionCode(p, shot) +
              " take " +
              (take + 1) +
              " segment " +
              (segment.index + 1),
            prompt: shot.videoPrompt,
            take: take + 1 + takeOffset,
            segment,
          });
        }
    }
  }
  const seconds = tasks.reduce(
      (n, t) =>
        n +
        (state.timings[(settings.modelProfileId || "default") + ":" + t.kind]
          ?.seconds ||
          state.timings[t.kind]?.seconds ||
          (t.kind === "image" ? 30 : 180)),
      0,
    ),
    price =
      Number(
        p.modelProfiles.find((m) => m.id === settings.modelProfileId)
          ?.parameters?.pricePerGeneration,
      ) || 0;
  if (!settings.chain)
    tasks.sort(
      (a, b) =>
        ["references", "keyframes", "videos"].indexOf(a.stage) -
        ["references", "keyframes", "videos"].indexOf(b.stage),
    );
  if (settings.chain) {
    const sceneOrder = new Map(p.scenes.map((s, i) => [s.id, i])),
      sceneOf = (task) =>
        p.shots.find((s) => s.id === task.target.shotId)?.sceneId;
    tasks.sort((a, b) =>
      a.stage === "references"
        ? -1
        : b.stage === "references"
          ? 1
          : (sceneOrder.get(sceneOf(a)) || 0) -
              (sceneOrder.get(sceneOf(b)) || 0) ||
            ["keyframes", "videos"].indexOf(a.stage) -
              ["keyframes", "videos"].indexOf(b.stage),
    );
  }
  if (settings.stageFilter) {
    const selected = tasks.filter((t) =>
      settings.stageFilter === "continuity"
        ? ["keyframes", "videos"].includes(t.stage)
        : t.stage === settings.stageFilter,
    );
    tasks.splice(0, tasks.length, ...selected);
  }
  return {
    tasks,
    jobs: tasks.length,
    seconds,
    spend: tasks.length * price,
    bytes: tasks.reduce((n, t) => n + (t.kind === "image" ? 2e6 : 25e6), 0),
  };
}
async function asProductionHealth(p, settings, plan) {
  if (asSimulationOn())
    return { problems: [], disk: await navigator.storage?.estimate?.() };
  const problems = [],
    server =
      K.getState().comfy.find((s) => s.id === settings.serverId) ||
      (asSimulationOn() ? { id: "simulation", url: "" } : null);
  for (const kind of new Set(plan.tasks.map((t) => t.kind))) {
    const workflow = K.getState().workflows.find(
      (w) =>
        w.id === settings[kind === "image" ? "workflowImage" : "workflowVideo"],
    );
    if (!workflow) problems.push("Choose a " + kind + " workflow");
    else problems.push(...(await asJobHealth(server, workflow)));
  }
  if (settings.autoAudio) {
    const data = asProduction(p);
    for (const character of new Set(
      p.shots.flatMap((s) => s.dialogue.map((l) => l.character)),
    )) {
      const voice = data.voices[character] || {};
      if (voice.workflowId) {
        const workflow = K.getState().workflows.find(
          (w) => w.id === voice.workflowId,
        );
        if (!workflow) problems.push("Missing voice workflow for " + character);
        else problems.push(...(await asJobHealth(server, workflow)));
      } else if (
        !K.getState().webApis.some(
          (a) => a.id === (voice.apiId || settings.ttsApiId),
        )
      )
        problems.push("Choose a dialogue audio adapter for " + character);
    }
  }
  if (settings.autoDelivery) {
    try {
      await asDelivery.ready;
      await asDeliveryTest();
    } catch (e) {
      problems.push("Export folder: " + e.message);
    }
  }
  if (!p.script.trim() && !p.shots.length)
    problems.push("Upload a screenplay or add shots first");
  const profile = p.modelProfiles.find((m) => m.id === settings.modelProfileId),
    supported = profile?.parameters?.supportedFps;
  if (
    Array.isArray(supported) &&
    supported.length &&
    !supported.map(Number).includes(Number(p.meta.frameRate))
  )
    problems.push(
      "Selected model does not support project FPS " + p.meta.frameRate,
    );
  const disk = await navigator.storage?.estimate?.();
  if (
    asHardware().manualFreeGB > 0 &&
    plan.bytes / 1e9 > asHardware().manualFreeGB
  )
    problems.push(
      "Estimated export exceeds manually supplied drive free space. Free disk space or reduce scope, then update Hardware.",
    );
  if (disk && disk.quota - disk.usage < plan.bytes)
    problems.push(
      "Estimated generated media exceeds available browser storage quota. Free storage or reduce scope.",
    );
  return { problems: [...new Set(problems)], disk };
}
const asBatch = {
  active: false,
  paused: false,
  stop: false,
  controller: null,
  stage: "",
  current: "",
  done: 0,
  total: 0,
  failures: [],
  listeners: new Set(),
};
function asBatchNotify() {
  for (const fn of asBatch.listeners) fn();
}
async function asBatchCheckpoint() {
  asBatch.controller.signal.throwIfAborted();
  while (asBatch.paused) {
    await new Promise((r) => setTimeout(r, 200));
    asBatch.controller.signal.throwIfAborted();
  }
}
async function asProductionGenerate(task, settings) {
  const p = G.getState().project,
    state = asProduction(p),
    shot = p.shots.find((s) => s.id === task.target.shotId),
    override = state.shots[shot?.id] || {},
    workflow = K.getState().workflows.find(
      (w) =>
        w.id ===
        ((task.stage !== "post" &&
          override[
            task.kind === "image" ? "workflowImage" : "workflowVideo"
          ]) ||
          settings[task.kind === "image" ? "workflowImage" : "workflowVideo"]),
    ),
    server =
      K.getState().comfy.find((s) => s.id === settings.serverId) ||
      (asSimulationOn() ? { id: "simulation", url: "" } : null);
  if ((!workflow || !server) && !asSimulationOn())
    throw Error("Configure a workflow and server");
  if (shot) {
    const errors = asPromptLint(shot, p).filter((i) => i.severity === "error");
    if (errors.length)
      throw Error("Invalid prompt: " + errors.map((i) => i.message).join("; "));
  }
  const refs = shot ? il(p, shot) : [];
  let ref =
    task.stage === "post"
      ? shot?.video.versions.find((v) => v.id === shot.video.approvedId)?.url
      : task.kind === "video"
        ? fl(shot?.image || { versions: [] })?.url
        : refs[0];
  if (task.stage !== "post" && shot && (override.chain ?? settings.chain)) {
    const ordered = asProductionOrdered(p),
      previous = ordered[ordered.findIndex((s) => s.id === shot.id) - 1],
      version = previous?.video.versions.find(
        (v) => v.id === previous.video.approvedId,
      );
    if (version) {
      const derived =
        state.shots[previous.id]?.derivedFrame?.url ||
        (await asProductionFrame(version.url));
      ref = derived;
      refs.unshift(derived);
    }
  }
  if (task.segment?.index > 0) {
    const parent = state.shots[shot.id]?.segments
      ?.filter(
        (s) => s.take === task.take && s.index === task.segment.index - 1,
      )
      .at(-1);
    const previous = shot.video.versions.find(
      (v) => v.id === parent?.versionId,
    );
    if (!previous) throw Error("Previous segment is unavailable");
    ref = await asProductionFrame(previous.url);
    refs.unshift(ref);
  }
  const before = new Set(K.getState().jobs.map((j) => j.id)),
    start = Date.now();
  asPipelineRuntime.comfyUsed = true;
  const generationTask = (asSimulationOn() ? asSimulationGenerate : F_)({
    ...task,
    workflow,
    server,
    refImage: task.stage === "post" ? undefined : ref,
    refVideo: task.stage === "post" ? ref : undefined,
    parentVersionId: task.stage === "post" ? shot?.video.approvedId : undefined,
    refImages: refs,
    negative: override.negative || shot?.negativePrompt || settings.negative,
    seed: task.retry ? "" : override.seed || settings.seed,
    segment: task.segment,
    extra: {
      ...p.modelProfiles.find(
        (m) => m.id === (override.modelProfileId || settings.modelProfileId),
      )?.parameters,
      lora: override.lora || settings.lora,
    },
  });
  const abort = () => {
    for (const job of K.getState().jobs.filter(
      (j) => !before.has(j.id) && j.projectId === Kl.getState().activeId,
    ))
      asCancelGeneration(job.id);
  };
  if (asBatch.active) {
    asBatch.controller.signal.addEventListener("abort", abort, { once: true });
    if (asBatch.controller.signal.aborted) abort();
  }
  try {
    await generationTask;
  } finally {
    asBatch.controller?.signal.removeEventListener("abort", abort);
  }
  const job = K.getState().jobs.find(
    (j) => !before.has(j.id) && j.target?.shotId === task.target.shotId,
  );
  if (!job || job.status !== "done" || !job.attached)
    throw Error(job?.log || "Provider did not save a result");
  if (task.target.asset) {
    const spec = task.target.asset,
      asset = G.getState().project[spec.kind].find((a) => a.id === spec.id);
    G.getState().updateAsset(spec.kind, spec.id, {
      refs: asset.refs.map((r) => ({
        ...r,
        locked: r.id === job.result.versionId || r.locked,
      })),
    });
  }
  if (task.stage === "post" && shot)
    await asProductionApprove(shot.id, job.result.versionId, false);
  await asProductionSave((data) => {
    const modelKey =
      (override.modelProfileId || settings.modelProfileId || "default") +
      ":" +
      task.kind;
    const old = data.timings[modelKey],
      seconds = (Date.now() - start) / 1000,
      count = (old?.count || 0) + 1;
    return {
      ...data,
      timings: {
        ...data.timings,
        [modelKey]: {
          count,
          seconds: ((old?.seconds || 0) * (count - 1) + seconds) / count,
        },
      },
      shots: shot
        ? {
            ...data.shots,
            [shot.id]: {
              ...data.shots[shot.id],
              referencesUsed: refs,
              segments: task.segment
                ? [
                    ...(data.shots[shot.id]?.segments || []),
                    {
                      ...task.segment,
                      versionId: job.result.versionId,
                      take: task.take,
                    },
                  ]
                : data.shots[shot.id]?.segments || [],
            },
          }
        : data.shots,
    };
  });
  return job;
}
async function asProductionRun(settings) {
  if (asBatch.active) throw Error("A production batch is already running");
  let p = G.getState().project;
  if (!p.shots.length)
    throw Error(
      "Run Analyze script first with an active LLM, or explicitly choose Offline parser in Pipeline.",
    );
  const plan = asProductionPlan(p, settings),
    health = await asProductionHealth(p, settings, plan);
  if (health.problems.length) throw Error(health.problems.join("\n"));
  Object.assign(asBatch, {
    active: true,
    paused: false,
    stop: false,
    controller: new AbortController(),
    done: 0,
    succeeded: 0,
    skipped: 0,
    total: plan.jobs,
    failures: [],
  });
  asBatchNotify();
  const projectId = Kl.getState().activeId;
  try {
    for (const task of plan.tasks) {
      await asBatchCheckpoint();
      if (Kl.getState().activeId !== projectId)
        throw Error("Batch stopped because the active project changed");
      if (asBatch.stop) break;
      asBatch.stage = task.stage;
      asBatch.current = task.label;
      asBatchNotify();
      let succeeded = false;
      try {
        await asExecuteProductionTask(
          task,
          settings,
          asBatch.controller.signal,
        );
        succeeded = true;
      } catch (e) {
        if (
          asBatch.controller.signal.aborted ||
          asErrorClass(e) === "cancelled"
        )
          throw e;
        if (asErrorClass(e) === "storage") throw e;
        asBatch.failures.push({
          task: task.label,
          taskSpec: task,
          shotId: task.target.shotId,
          reason: e.message,
        });
      }
      if (succeeded) {
        asBatch.succeeded++;
        asBatch.done = asBatch.succeeded + asBatch.skipped;
      }
      if (succeeded && task.kind === "video") {
        const shot = G.getState().project.shots.find(
          (s) => s.id === task.target.shotId,
        );
        if (!asProduction().shots[shot.id]?.qc?.[shot.video.versions.at(-1).id])
          await asProductionQC(shot.id, shot.video.versions.at(-1).id).catch(
            (e) =>
              asBatch.failures.push({
                task: task.label + " QC",
                reason: e.message,
              }),
          );
      }
      await asProductionSave((d) => ({
        ...d,
        batch: {
          done: asBatch.done,
          total: asBatch.total,
          failures: asBatch.failures,
          finished: false,
        },
      }));
      asBatchNotify();
    }
    if (
      settings.autoAudio &&
      !asBatch.stop &&
      !asBatch.controller.signal.aborted
    )
      await asAudioAll();
    if (
      settings.autoDelivery &&
      !asBatch.stop &&
      !asBatch.controller.signal.aborted
    )
      await asDeliveryRun(asDeliveryProject(G.getState().project, "delivery"), {
        scope: "delivery",
      });
    await asProductionSave((d) => ({
      ...d,
      batch: {
        done: asBatch.done,
        total: asBatch.total,
        failures: asBatch.failures,
        succeeded: asBatch.succeeded,
        skipped: asBatch.skipped,
        remaining: Math.max(
          0,
          asBatch.total -
            asBatch.succeeded -
            asBatch.skipped -
            asBatch.failures.length,
        ),
        finished:
          asBatch.done === asBatch.total && asBatch.failures.length === 0,
        status: asBatch.failures.length
          ? "Finished with " + asBatch.failures.length + " failures"
          : asBatch.done === asBatch.total
            ? "Finished"
            : "Stopped",
      },
    }));
  } finally {
    asBatch.active = false;
    asBatchNotify();
  }
}
async function asProductionApprove(shotId, versionId, runPost = true) {
  const shot = G.getState().project.shots.find((s) => s.id === shotId);
  if (!shot?.video.versions.some((v) => v.id === versionId))
    throw Error("Take is unavailable");
  G.getState().updateShot(shotId, {
    video: { ...shot.video, approvedId: versionId },
    stage: "video_approved",
  });
  await asProductionSave(
    (d) => ({
      ...d,
      shots: {
        ...d.shots,
        [shotId]: {
          ...d.shots[shotId],
          rejected: shot.video.versions
            .filter((v) => v.id !== versionId)
            .map((v) => v.id),
        },
      },
    }),
    "approve-take",
  );
  const settings = asProduction().settings;
  if (runPost && settings.autoPost && settings.postWorkflowId)
    await asProductionGenerate(
      {
        stage: "post",
        kind: "video",
        target: { shotId },
        label: "Post-process " + asProductionCode(G.getState().project, shot),
        prompt: shot.videoPrompt,
      },
      { ...settings, workflowVideo: settings.postWorkflowId },
    );
}
async function asProductionFrame(url, time) {
  const blob = await asDeliveryBlob(url),
    object = URL.createObjectURL(blob),
    video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = object;
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(Error("Cannot decode reference video"));
    });
    const target = Math.max(
      0,
      Math.min(
        Number.isFinite(time) ? time : video.duration - 0.05,
        video.duration - 0.001,
      ),
    );
    await new Promise((resolve, reject) => {
      video.onseeked = resolve;
      video.onerror = () => reject(Error("Reference seek failed"));
      video.currentTime = target;
    });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const frame = await new Promise((r) => canvas.toBlob(r, "image/png"));
    canvas.width = canvas.height = 0;
    return asMediaPut(frame);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(object);
  }
}
async function asProductionQC(shotId, versionId) {
  const p = G.getState().project,
    shot = p.shots.find((s) => s.id === shotId),
    version =
      shot?.video.versions.find((v) => v.id === versionId) ||
      shot?.image.versions.find((v) => v.id === versionId);
  if (!version) throw Error("Take unavailable");
  const blob = await asDeliveryBlob(version.url),
    object = URL.createObjectURL(blob),
    video = blob.type.startsWith("video/"),
    media = video ? document.createElement("video") : new Image(),
    flags = [],
    samples = [];
  media.src = object;
  if (video) media.muted = true;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("QC media decode timed out")),
        15000,
      );
      media[video ? "onloadedmetadata" : "onload"] = () => {
        clearTimeout(timer);
        resolve();
      };
      media.onerror = () => {
        clearTimeout(timer);
        reject(Error("QC cannot decode media"));
      };
    });
    const width = video ? media.videoWidth : media.naturalWidth,
      height = video ? media.videoHeight : media.naturalHeight,
      duration = video
        ? Number.isFinite(media.duration)
          ? media.duration
          : version.durationS || null
        : null,
      canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const c = canvas.getContext("2d", { willReadFrequently: true });
    for (const fraction of video ? [0.05, 0.3, 0.6, 0.9] : [0]) {
      if (video)
        await new Promise((r) => {
          media.onseeked = r;
          media.currentTime = Math.max(
            0.001,
            (duration || shot.duration) * fraction,
          );
        });
      c.drawImage(media, 0, 0, 32, 32);
      const pixels = c.getImageData(0, 0, 32, 32).data,
        values = [];
      for (let i = 0; i < pixels.length; i += 4)
        values.push((pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3);
      samples.push(values);
    }
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length,
      brightness = samples.map(mean);
    if (brightness.some((b) => b < 8)) flags.push("Black or very dark frame");
    if (
      video &&
      samples
        .slice(1)
        .every((a, i) => mean(a.map((v, k) => Math.abs(v - samples[i][k]))) < 1)
    )
      flags.push("Near-duplicate sampled frames (heuristic)");
    if (brightness.some((b, i) => i && Math.abs(b - brightness[i - 1]) > 90))
      flags.push("Abrupt brightness jump");
    if (
      video &&
      Math.abs(duration - shot.duration) >
        Math.max(0.1, shot.duration * asProduction(p).settings.qcTolerance)
    )
      flags.push("Duration differs from plan");
    if (Math.abs(width / height - al(p.meta.aspectRatio)) > 0.04)
      flags.push("Aspect ratio differs from project");
    const expected = ol(p.meta.aspectRatio);
    if (width !== expected.width || height !== expected.height)
      flags.push("Resolution differs from project target");
    const reference = il(p, shot)[0];
    if (reference) {
      try {
        const image = new Image(),
          refBlob = await asDeliveryBlob(reference),
          refUrl = URL.createObjectURL(refBlob);
        try {
          image.src = refUrl;
          await image.decode();
          c.drawImage(image, 0, 0, 32, 32);
          const pixels = c.getImageData(0, 0, 32, 32).data;
          let diff = 0;
          for (let i = 0; i < 1024; i++)
            diff += Math.abs(
              (pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]) / 3 -
                samples[0][i],
            );
          if (diff / 1024 > 65)
            flags.push(
              "Reference appearance drift (pixel heuristic, not identity recognition)",
            );
        } finally {
          URL.revokeObjectURL(refUrl);
        }
      } catch (e) {
        flags.push("Reference similarity unavailable: " + e.message);
      }
    }
    const fps = version.fps || null;
    if (fps && Math.abs(fps - Number(p.meta.frameRate)) > 0.1)
      flags.push("FPS differs from project");
    const qc = {
      flags,
      score: Math.max(0, 100 - flags.length * 15),
      width,
      height,
      duration,
      fps,
      notes:
        "Sampled pixel heuristic; face identity is not verified. FPS is unknown unless supplied by the provider.",
      measuredAt: Date.now(),
    };
    await asProductionSave(
      (d) => ({
        ...d,
        shots: {
          ...d.shots,
          [shotId]: {
            ...d.shots[shotId],
            qc: { ...d.shots[shotId]?.qc, [versionId]: qc },
          },
        },
      }),
      "qc",
    );
    return qc;
  } finally {
    if (video) {
      media.removeAttribute("src");
      media.load();
    }
    URL.revokeObjectURL(object);
  }
}
function asEditFPS(p) {
  const fps = Number(p.meta.frameRate) || 24;
  return Math.abs(fps - 23.976) < 0.01
    ? { num: 24000, den: 1001, nominal: 24 }
    : Math.abs(fps - 29.97) < 0.01
      ? { num: 30000, den: 1001, nominal: 30 }
      : Math.abs(fps - 59.94) < 0.01
        ? { num: 60000, den: 1001, nominal: 60 }
        : { num: fps, den: 1, nominal: Math.round(fps) };
}
function asTimecode(frames, fps) {
  const f = Math.max(0, Math.round(frames)),
    rate = typeof fps === "number" ? Math.round(fps) : fps.nominal;
  return [
    Math.floor(f / rate / 3600),
    Math.floor(f / rate / 60) % 60,
    Math.floor(f / rate) % 60,
    f % rate,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}
function asXML(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}
function asSRTTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return (
    [
      Math.floor(ms / 3600000),
      Math.floor(ms / 60000) % 60,
      Math.floor(ms / 1000) % 60,
    ]
      .map((n) => String(n).padStart(2, "0"))
      .join(":") +
    "," +
    String(ms % 1000).padStart(3, "0")
  );
}
function asApprovedParts(p, shot) {
  const approved = shot.video.versions.find(
    (v) => v.id === shot.video.approvedId,
  );
  if (!approved) return [];
  const records = asProduction(p).shots[shot.id]?.segments || [],
    chosen = records.find((r) => r.versionId === approved.id);
  if (!chosen)
    return [
      { version: approved, duration: shot.duration, suffix: "", start: 0 },
    ];
  const group = records
    .filter((r) => r.take === chosen.take)
    .sort((a, b) => a.index - b.index);
  if (group.length === 1 && group[0].duration >= shot.duration - 0.01)
    return [
      { version: approved, duration: shot.duration, suffix: "", start: 0 },
    ];
  if (
    Math.abs(group.reduce((n, r) => n + r.duration, 0) - shot.duration) > 0.05
  )
    throw Error("Approved segmented take is incomplete: " + shot.id);
  return group.map((r, i) => {
    const version = shot.video.versions.find((v) => v.id === r.versionId);
    if (!version) throw Error("Missing approved segment " + r.versionId);
    return {
      version,
      duration: r.duration,
      start: r.start,
      suffix: "_part" + String(i + 1).padStart(2, "0"),
    };
  });
}
async function asEditTimeline(p) {
  const fps = asEditFPS(p),
    state = asProduction(p);
  let cursor = 0;
  const clips = [];
  for (const shot of asProductionOrdered(p)) {
    const scene = p.scenes.find((s) => s.id === shot.sceneId),
      code = asProductionCode(p, shot),
      parts = asApprovedParts(p, shot);
    for (const part of parts.length
      ? parts
      : [{ duration: shot.duration, version: null, suffix: "" }]) {
      const frames = Math.max(
        1,
        Math.round((part.duration * fps.num) / fps.den),
      );
      let path = null;
      if (part.version) {
        const blob = await asDeliveryBlob(part.version.url);
        path =
          "../04_Approved_Clips/Scene_" +
          String(scene?.number || 1).padStart(3, "0") +
          "/" +
          asDeliverySlug(code + part.suffix) +
          "." +
          asDeliveryExt(blob);
      }
      clips.push({
        shot: {
          ...shot,
          duration: part.duration,
          dialogue: part.start ? [] : shot.dialogue,
        },
        version: part.version,
        path,
        code: code + part.suffix,
        start: cursor,
        frames,
        reel: ("R" + String(clips.length + 1).padStart(7, "0")).slice(-8),
      });
      cursor += frames;
    }
  }
  return { fps, clips, frames: cursor, state };
}
async function* asEditFiles(p) {
  if (p.pipeline?.morningReport)
    yield {
      path: "07_Reports/morning_report.md",
      open: () => asRedact(p.pipeline.morningReport),
    };
  if (asPipelineRuntime.log.length)
    yield {
      path: "07_Reports/run_log.jsonl",
      open: () => asPipelineRuntime.log.map((e) => asRedact(e)).join("\n"),
    };

  const { fps, clips, frames, state } = await asEditTimeline(p),
    seconds = (f) => (f * fps.den) / fps.num,
    rat = (f) => `${Math.round(f) * fps.den}/${fps.num}s`,
    text = (path, value) => ({
      path: "06_Edit_Handoff/" + path,
      open: () =>
        typeof value === "string" ? value : JSON.stringify(value, null, 2),
    });
  let edl =
      "TITLE: " +
      p.meta.title.replace(/[\r\n]/g, " ") +
      "\nFCM: NON-DROP FRAME\n\n",
    fcpxAssets = "",
    fcpxClips = "",
    otio = [],
    markers = [],
    shotlist = [],
    missing = [],
    qc = [],
    prompts = [];
  const subtitles = { te: [], en: [] };
  let event = 0;
  for (const clip of clips) {
    const { shot, path, version, code, start, frames: duration } = clip,
      id = "r" + (event + 1),
      comment = [
        shot.action,
        ...shot.dialogue.map((l) => l.character + ": " + l.line),
        shot.soundCue,
        shot.notes,
      ]
        .filter(Boolean)
        .join(" | ");
    if (path) {
      event++;
      edl +=
        String(event).padStart(3, "0") +
        "  " +
        clip.reel +
        " V     C        " +
        asTimecode(0, fps) +
        " " +
        asTimecode(duration, fps) +
        " " +
        asTimecode(start, fps) +
        " " +
        asTimecode(start + duration, fps) +
        "\n* FROM CLIP NAME: " +
        path +
        "\n* COMMENT: " +
        comment.replace(/[\r\n]/g, " ") +
        "\n\n";
      fcpxAssets += `<asset id="${id}" name="${asXML(code)}" start="0s" duration="${rat(duration)}" hasVideo="1" format="rFormat"><media-rep kind="original-media" src="${asXML(path)}"/></asset>`;
      fcpxClips += `<asset-clip name="${asXML(code)}" ref="${id}" offset="${rat(start)}" start="0s" duration="${rat(duration)}"><marker start="0s" value="${asXML(comment)}"/></asset-clip>`;
      otio.push({
        OTIO_SCHEMA: "Clip.2",
        name: code,
        source_range: {
          OTIO_SCHEMA: "TimeRange.1",
          start_time: {
            OTIO_SCHEMA: "RationalTime.1",
            value: 0,
            rate: fps.num / fps.den,
          },
          duration: {
            OTIO_SCHEMA: "RationalTime.1",
            value: duration,
            rate: fps.num / fps.den,
          },
        },
        active_media_reference_key: "DEFAULT_MEDIA",
        media_references: {
          DEFAULT_MEDIA: {
            OTIO_SCHEMA: "ExternalReference.1",
            target_url: path,
            available_range: null,
            metadata: {},
          },
        },
        effects: [],
        markers: [],
        metadata: {
          action: shot.action,
          dialogue: shot.dialogue,
          soundCue: shot.soundCue,
        },
      });
    } else {
      fcpxClips += `<gap name="${asXML(code + " MISSING APPROVED CLIP")}" offset="${rat(start)}" start="0s" duration="${rat(duration)}"/>`;
      otio.push({
        OTIO_SCHEMA: "Gap.1",
        name: code + " MISSING",
        source_range: {
          OTIO_SCHEMA: "TimeRange.1",
          start_time: {
            OTIO_SCHEMA: "RationalTime.1",
            value: 0,
            rate: fps.num / fps.den,
          },
          duration: {
            OTIO_SCHEMA: "RationalTime.1",
            value: duration,
            rate: fps.num / fps.den,
          },
        },
        effects: [],
        markers: [],
        metadata: {},
      });
      missing.push({ shotId: shot.id, code, reason: "No approved video" });
    }
    markers.push({
      shotId: shot.id,
      timecode: asTimecode(start, fps),
      scene: asSceneLabel(p.scenes.find((s) => s.id === shot.sceneId)),
      action: shot.action,
      dialogue: shot.dialogue
        .map((l) => l.character + ": " + l.line)
        .join(" | "),
      notes: shot.notes,
    });
    shotlist.push({
      scene: markers.at(-1).scene,
      shot: code,
      type: shot.type,
      angle: shot.angle,
      movement: shot.movement,
      lens: shot.lens,
      duration: shot.duration,
      characters: shot.characterIds
        .map((id) => p.characters.find((c) => c.id === id)?.name || id)
        .join("; "),
      environment:
        p.environments.find((e) => e.id === shot.environmentId)?.name || "",
      file: path || "",
      approval: version ? "approved" : "missing",
    });
    prompts.push({
      shotId: shot.id,
      code,
      imagePrompt: shot.imagePrompt,
      videoPrompt: shot.videoPrompt,
      negativePrompt: shot.negativePrompt,
    });
    for (const [i, line] of shot.dialogue.entries()) {
      const key = shot.id + ":" + i,
        audio = state.audio.find(
          (a) => a.lineKey === key && a.text === line.line,
        );
      if (!audio)
        missing.push({
          shotId: shot.id,
          code,
          reason: "Dialogue audio missing: " + (i + 1) + " " + line.character,
        });
      const lang = line.lang === "te" ? "te" : "en",
        offset =
          Number(state.shots[shot.id]?.lineOffsets?.[i]) ||
          (i * shot.duration) / Math.max(1, shot.dialogue.length),
        end = Math.min(
          shot.duration,
          offset + shot.duration / Math.max(1, shot.dialogue.length),
        );
      if (end > offset)
        subtitles[lang].push(
          asSRTTime(seconds(start) + offset) +
            " --> " +
            asSRTTime(seconds(start) + end) +
            "\n" +
            line.line,
        );
    }
    for (const [versionId, record] of Object.entries(
      state.shots[shot.id]?.qc || {},
    ))
      qc.push({
        shotId: shot.id,
        code,
        versionId,
        score: record.score,
        flags: record.flags.join("; "),
        notes: record.notes,
      });
  }
  yield text("project.edl", edl);
  yield text(
    "project.fcpxml",
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10"><resources><format id="rFormat" name="ASTRA" frameDuration="${fps.den}/${fps.num}s" width="${ol(p.meta.aspectRatio).width}" height="${ol(p.meta.aspectRatio).height}"/>${fcpxAssets}</resources><library><event name="${asXML(p.meta.title)}"><project name="${asXML(p.meta.title)}"><sequence format="rFormat" duration="${rat(frames)}" tcStart="0s" tcFormat="NDF"><spine>${fcpxClips}</spine></sequence></project></event></library></fcpxml>`,
  );
  yield text("project.otio", {
    OTIO_SCHEMA: "Timeline.1",
    name: p.meta.title,
    global_start_time: {
      OTIO_SCHEMA: "RationalTime.1",
      value: 0,
      rate: fps.num / fps.den,
    },
    metadata: {},
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: [
        {
          OTIO_SCHEMA: "Track.1",
          name: "Video",
          kind: "Video",
          children: otio,
          effects: [],
          markers: [],
          metadata: {},
        },
      ],
      effects: [],
      markers: [],
      metadata: {},
    },
  });
  yield text("markers.csv", ll(markers));
  yield text("shotlist.csv", ll(shotlist));
  for (const lang of ["te", "en"])
    yield text(
      "subtitles_" + lang + ".srt",
      subtitles[lang].map((s, i) => i + 1 + "\n" + s + "\n").join("\n"),
    );
  for (const [file, rows] of Object.entries({
    "missing_assets.csv": missing,
    "qc_report.csv": qc,
    "prompts_log.csv": prompts,
    "production_report.csv": shotlist,
    "cost_time_report.csv": Object.entries(state.timings).map(
      ([kind, value]) => ({ kind, ...value }),
    ),
  }))
    yield {
      path: "07_Reports/" + file,
      open: () => (rows.length ? ll(rows) : "status\nNo records\n"),
    };
  for (const audio of [...state.audio, ...state.cues]) {
    const blob = await asDeliveryBlob(audio.url);
    yield {
      path:
        "05_Audio/" +
        (audio.section || "dialogue") +
        "/" +
        asDeliverySlug(audio.name, audio.id) +
        "." +
        asDeliveryExt(blob),
      sourceId: audio.shotId || audio.id,
      version: audio.id,
      open: () => asDeliveryBlob(audio.url),
    };
  }
}
async function asAudioAdapter(apiId, variables) {
  const api = K.getState().webApis.find((a) => a.id === apiId);
  if (!api) throw Error("Choose an audio/lip-sync web adapter in Connections");
  const headers = { "content-type": "application/json" },
    separator = (api.authHeader || "").indexOf(":");
  if (separator > 0)
    headers[api.authHeader.slice(0, separator).trim()] = api.authHeader
      .slice(separator + 1)
      .trim();
  const body = N_(api.template || '{"text":"{{text}}"}', variables),
    response = await fetch(api.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: asBatch.active ? asBatch.controller.signal : undefined,
    });
  if (!response.ok)
    throw Error(
      "Audio adapter HTTP " +
        response.status +
        ": " +
        (await response.text()).slice(0, 300),
    );
  let blob;
  if (response.headers.get("content-type")?.match(/^(audio|video)\//))
    blob = await response.blob();
  else {
    let result = await response.json();
    for (const key of (api.responsePath || "url").split(".").filter(Boolean))
      result = result?.[key];
    if (typeof result !== "string")
      throw Error("Audio adapter returned no media");
    if (!/^(https?:|data:)/.test(result))
      throw Error("Audio adapter must return a media URL or data URL");
    const media = await fetch(result);
    if (!media.ok) throw Error("Audio download HTTP " + media.status);
    blob = await media.blob();
  }
  if (!/^(audio|video)\//.test(blob.type))
    throw Error("Adapter output is not audio or video");
  return asMediaPut(blob);
}
async function asAudioLine(shotId, index) {
  if (asSimulationOn()) {
    await asPipelineDelay(K.getState().simulation?.latencyMs || 20);
    asSimulationFailure("audio");
    const data = new Uint8Array(44 + 1600),
      view = new DataView(data.buffer),
      write = (at, text) =>
        [...text].forEach((c, i) => (data[at + i] = c.charCodeAt(0)));
    write(0, "RIFF");
    view.setUint32(4, data.length - 8, true);
    write(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true);
    view.setUint32(28, 16000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    write(36, "data");
    view.setUint32(40, 1600, true);
    return asAudioUpload(
      new File([data], "SIMULATION.wav", { type: "audio/wav" }),
      G.getState().project.shots.find((s) => s.id === shotId),
      index,
    );
  }

  const p = G.getState().project,
    projectId = Kl.getState().activeId,
    shot = p.shots.find((s) => s.id === shotId),
    line = shot.dialogue[index],
    state = asProduction(p),
    voice = state.voices[line.character] || {};
  if (voice.workflowId) {
    const workflow = K.getState().workflows.find(
        (w) => w.id === voice.workflowId,
      ),
      server = K.getState().comfy.find((c) => c.id === state.settings.serverId);
    if (!workflow || !server)
      throw Error("Choose a ComfyUI server and voice workflow");
    const problems = await asJobHealth(server, workflow);
    if (problems.length) throw Error(problems.join("\n"));
    const before = new Set(K.getState().jobs.map((j) => j.id));
    await F_({
      kind: "audio",
      label: "Dialogue " + asProductionCode(p, shot),
      target: { shotId, audioLine: index },
      prompt: line.line,
      negative: "",
      server,
      workflow,
      extra: {
        text: line.line,
        language: line.lang,
        voice: voice.voiceId || "",
        speed: voice.speed || 1,
      },
    });
    const job = K.getState().jobs.find((j) => !before.has(j.id));
    if (job?.status !== "done" || !job.attached)
      throw Error(job?.log || "TTS failed");
    return;
  }
  const url = await asAudioAdapter(voice.apiId || state.settings.ttsApiId, {
    text: line.line,
    language: line.lang,
    voice: voice.voiceId || "",
    speed: voice.speed || 1,
    reference_audio: voice.reference
      ? await asMediaPortable(voice.reference)
      : "",
    shot: asProductionCode(p, shot),
  });
  if (
    Kl.getState().activeId !== projectId ||
    G.getState().project.shots.find((s) => s.id === shotId)?.dialogue[index]
      ?.line !== line.line
  )
    throw Error(
      "Audio target changed; result remains in local media storage and was not attached",
    );
  const key = shot.id + ":" + index,
    record = {
      id: Zc("audio"),
      lineKey: key,
      shotId,
      index,
      character: line.character,
      lang: line.lang,
      name:
        asProductionCode(p, shot) +
        "_L" +
        String(index + 1).padStart(2, "0") +
        "_" +
        asDeliverySlug(line.character),
      url,
      text: line.line,
    };
  await asProductionSave(
    (d) => ({
      ...d,
      audio: [...d.audio.filter((a) => a.lineKey !== key), record],
    }),
    "dialogue-audio",
  );
}
async function asAudioAll() {
  const errors = [];
  for (const shot of asProductionOrdered(G.getState().project))
    for (let i = 0; i < shot.dialogue.length; i++) {
      if (asBatch.active) await asBatchCheckpoint();
      if (
        asProduction().audio.some(
          (a) =>
            a.lineKey === shot.id + ":" + i && a.text === shot.dialogue[i].line,
        )
      )
        continue;
      for (
        let attempt = 0;
        attempt < asProduction().settings.attempts;
        attempt++
      ) {
        try {
          if (asBatch.active) await asBatchCheckpoint();
          await asAudioLine(shot.id, i);
          break;
        } catch (e) {
          if (asBatch.controller?.signal.aborted && asBatch.active) throw e;
          if (attempt + 1 === asProduction().settings.attempts)
            errors.push({
              task: shot.id + " dialogue " + (i + 1),
              reason: e.message,
            });
          else
            await asPipelineDelay(
              Math.min(30000, 1000 * 2 ** attempt),
              asBatch.controller.signal,
            );
        }
      }
    }
  if (asBatch.active) asBatch.failures.push(...errors);
  else if (errors.length)
    throw Error(errors.map((e) => e.task + ": " + e.reason).join("\n"));
}
async function asAudioUpload(file, shot, index) {
  if (!file.type.startsWith("audio/")) throw Error("Choose an audio file");
  const url = await asMediaPut(file),
    line = shot.dialogue[index],
    key = shot.id + ":" + index;
  await asProductionSave((d) => ({
    ...d,
    audio: [
      ...d.audio.filter((a) => a.lineKey !== key),
      {
        id: Zc("audio"),
        lineKey: key,
        shotId: shot.id,
        index,
        lang: line.lang,
        character: line.character,
        text: line.line,
        url,
        name:
          asProductionCode(G.getState().project, shot) +
          "_L" +
          String(index + 1).padStart(2, "0") +
          "_" +
          asDeliverySlug(line.character),
      },
    ],
  }));
}
async function asProductionLipSync(shotId) {
  const p = G.getState().project,
    state = asProduction(p),
    shot = p.shots.find((s) => s.id === shotId),
    version = shot.video.versions.find((v) => v.id === shot.video.approvedId),
    audio = state.audio.find((a) => a.shotId === shotId);
  if (!version || !audio)
    throw Error("Approve a video and attach dialogue audio first");
  const originId = Kl.getState().activeId,
    revision = asTargetRevision(shot);
  const portable = await asMediaPortable({
      video: version.url,
      audio: audio.url,
    }),
    url = await asAudioAdapter(state.settings.lipSyncApiId, {
      ...portable,
      text: shot.dialogue.map((l) => l.line).join("\n"),
    });
  const next = asAttachGeneration(
    p,
    "video",
    { shotId },
    url,
    "lip-sync",
    Zc("ver"),
  );
  G.getState().replace(next, "Before lip-sync");
  await Ul();
}
async function asProductionVerify() {
  await asDelivery.ready;
  if (!(await asDeliveryPermission()))
    throw Error("Export folder needs permission");
  const p = G.getState().project,
    slug = asDeliverySlug(p.meta.title, Kl.getState().activeId),
    root = (await Wo("astra-last-export:" + slug))?.rootName || slug,
    { handle } = await asDeliveryFile(
      asDelivery.handle,
      root + "/manifest.json",
    ),
    manifest = JSON.parse(await (await handle.getFile()).text()),
    failures = [];
  for (const entry of manifest.files) {
    try {
      const file = await (
          await asDeliveryFile(asDelivery.handle, entry.path)
        ).handle.getFile(),
        hash = await asDeliveryHash(file);
      if (hash.bytes !== entry.bytes || hash.sha256 !== entry.sha256)
        failures.push(entry.path + ": content mismatch");
    } catch (e) {
      failures.push(entry.path + ": " + e.message);
    }
  }
  for (const shot of p.shots) {
    if (!shot.video.approvedId)
      failures.push(asProductionCode(p, shot) + ": no approved take");
    else if (
      !manifest.files.some(
        (f) =>
          f.sourceId === shot.id &&
          f.version === shot.video.approvedId &&
          f.approved,
      )
    )
      failures.push(
        asProductionCode(p, shot) + ": approved take has not been exported",
      );
    for (const [index, line] of shot.dialogue.entries()) {
      const audio = asProduction(p).audio.find(
        (a) => a.lineKey === shot.id + ":" + index && a.text === line.line,
      );
      if (!audio)
        failures.push(shot.id + ": dialogue " + (index + 1) + " is unvoiced");
      else if (!manifest.files.some((f) => f.version === audio.id))
        failures.push(
          shot.id + ": dialogue " + (index + 1) + " has not been exported",
        );
    }
  }
  return { files: manifest.files.length, failures };
}
function asRevisionDiff(p) {
  const prior = asProduction(p).revision;
  if (!prior)
    return {
      changed: p.scenes.map((s) => s.id),
      added: p.scenes.map((s) => s.id),
      removed: [],
    };
  const now = tl(p.script),
    changed = p.scenes
      .filter((s) => {
        const newScene = now.find(
          (n) =>
            (n.scriptNumber && n.scriptNumber === s.scriptNumber) ||
            n.slug === s.slug,
        );
        return (
          !newScene ||
          newScene.text !== prior.scenes.find((v) => v.id === s.id)?.text
        );
      })
      .map((s) => s.id);
  return {
    changed,
    added: now
      .filter((n) => !prior.scenes.some((s) => s.slug === n.slug))
      .map((n) => n.slug),
    removed: prior.scenes
      .filter((s) => !now.some((n) => n.slug === s.slug))
      .map((s) => s.id),
  };
}
function asProductionPage() {
  const p = G((s) => s.project),
    connections = K((s) => s.comfy),
    workflows = K((s) => s.workflows),
    apis = K((s) => s.webApis),
    state = asProduction(p),
    settings = state.settings,
    [tab, setTab] = j.useState(
      new URLSearchParams(location.hash.split("?")[1] || "").get("tab") ||
        "Plan",
    ),
    [message, setMessage] = j.useState(""),
    [index, setIndex] = j.useState(0),
    [page, setPage] = j.useState(0),
    [health, setHealth] = j.useState(null),
    [, refresh] = j.useReducer((n) => n + 1, 0);
  const shots = asProductionSelect(p, settings),
    shot = shots[Math.min(index, shots.length - 1)],
    plan = asProductionPlan(p, settings);
  j.useEffect(() => {
    asBatch.listeners.add(refresh);
    return () => asBatch.listeners.delete(refresh);
  }, []);
  const act = (fn) => async () => {
      try {
        setMessage("");
        await fn();
      } catch (e) {
        setMessage(e.message);
      }
    },
    save = (key, value) =>
      asProductionSave((d) => ({
        ...d,
        settings: { ...d.settings, [key]: value },
      })),
    override = (key, value) =>
      asProductionSave((d) => ({
        ...d,
        shots: { ...d.shots, [shot.id]: { ...d.shots[shot.id], [key]: value } },
      })),
    button = (label, fn, disabled = false) =>
      asEl(Z, { onClick: act(fn), disabled }, label),
    select = (label, value, items, fn) =>
      asEl(
        "label",
        {},
        label,
        asEl(
          "select",
          {
            className: "field",
            value: value || "",
            onChange: (e) =>
              fn(e.target.value).catch((error) => setMessage(error.message)),
          },
          asEl("option", { value: "" }, "Choose…"),
          ...items.map((item) =>
            asEl(
              "option",
              { key: item.id, value: item.id },
              item.name || item.model || item.id,
            ),
          ),
        ),
      ),
    input = (label, value, fn, type = "text") =>
      asEl(
        "label",
        {},
        label,
        asEl("input", {
          className: "field",
          type,
          value: value ?? "",
          onChange: (e) =>
            fn(type === "number" ? Number(e.target.value) : e.target.value),
        }),
      );
  j.useEffect(() => {
    if (tab !== "Review") return;
    const key = (e) => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      if (
        [" ", "1", "2", "3", "4", "n", "p", "k", "r"].includes(
          e.key.toLowerCase(),
        )
      )
        e.preventDefault();
      const i = Number(e.key) - 1;
      if (i >= 0 && i < 4 && shot?.video.versions[i])
        act(() =>
          asProductionApprove(shot.id, shot.video.versions[page * 4 + i].id),
        )();
      else if (e.key.toLowerCase() === "n")
        setIndex((i) => Math.min(shots.length - 1, i + 1));
      else if (e.key.toLowerCase() === "p") setIndex((i) => Math.max(0, i - 1));
      else if (e.key === " ")
        document
          .querySelectorAll(".astra-take-review video")
          .forEach((v) => (v.paused ? v.play().catch(() => {}) : v.pause()));
      else if (e.key.toLowerCase() === "k")
        act(() => override("flagged", !state.shots[shot.id]?.flagged))();
      else if (e.key.toLowerCase() === "r")
        act(async () => {
          await override(
            "rejected",
            shot.video.versions.map((v) => v.id),
          );
          await asProductionGenerate(
            {
              kind: "video",
              target: { shotId: shot.id },
              label: asProductionCode(p, shot),
              prompt: shot.videoPrompt,
            },
            settings,
          );
        })();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [tab, shot, settings, page]);
  return asEl(
    "div",
    { className: "p-6 grid gap-4 astra-produce" },
    asEl(R_, {
      title: "Auto-Produce",
      sub: "Plan, generate, review and deliver local production assets.",
    }),
    asEl(
      "nav",
      {
        className: "flex flex-wrap gap-2",
        "aria-label": "Production pipeline",
      },
      ...[
        "Plan",
        "Review",
        "Audio",
        "QC & Post",
        "Animatic & Revisions",
        "Final checklist",
      ].map((name) =>
        button(name, () => {
          setPage(0);
          setTab(name);
        }),
      ),
    ),
    button("Download production schema v3", () =>
      ul("project_schema_v3.json", JSON.stringify(asProductionJSONSchema)),
    ),
    asEl("p", { role: "status", style: { whiteSpace: "pre-wrap" } }, message),
    tab === "Plan" &&
      asEl(
        "section",
        { className: "grid gap-3" },
        asEl("h2", {}, "Production plan"),
        select(
          "Scope",
          settings.scope,
          [
            { id: "missing", name: "Only missing items" },
            { id: "all", name: "All scenes (preserve approved work)" },
            { id: "selected", name: "Selected scenes" },
          ],
          (v) => save("scope", v),
        ),
        settings.scope === "selected" &&
          asEl(
            "select",
            {
              className: "field",
              multiple: true,
              value: settings.sceneIds,
              onChange: (e) =>
                save(
                  "sceneIds",
                  [...e.target.selectedOptions].map((o) => o.value),
                ),
            },
            ...p.scenes.map((s) =>
              asEl(
                "option",
                { key: s.id, value: s.id },
                asSceneLabel(s) + " " + s.slug,
              ),
            ),
          ),
        select("ComfyUI server", settings.serverId, connections, (v) =>
          save("serverId", v),
        ),
        ...connections
          .filter((c) => c.id === settings.serverId)
          .map((server) =>
            input(
              "Server concurrency",
              server.concurrency || 1,
              (v) => {
                K.getState().update({
                  comfy: connections.map((c) =>
                    c.id === server.id
                      ? { ...c, concurrency: Math.max(1, Math.min(8, v)) }
                      : c,
                  ),
                });
              },
              "number",
            ),
          ),
        select("Keyframe workflow", settings.workflowImage, workflows, (v) =>
          save("workflowImage", v),
        ),
        select("Video workflow", settings.workflowVideo, workflows, (v) =>
          save("workflowVideo", v),
        ),
        select("Model profile", settings.modelProfileId, p.modelProfiles, (v) =>
          save("modelProfileId", v),
        ),
        ...p.modelProfiles
          .filter((m) => m.id === settings.modelProfileId)
          .map((profile) =>
            asEl(
              "div",
              { key: profile.id },
              input(
                "Model maximum clip length (seconds)",
                profile.parameters.maxClipLength || 0,
                (v) => {
                  G.getState().set((p) => ({
                    ...p,
                    modelProfiles: p.modelProfiles.map((m) =>
                      m.id === profile.id
                        ? {
                            ...m,
                            parameters: { ...m.parameters, maxClipLength: v },
                          }
                        : m,
                    ),
                  }));
                },
                "number",
              ),
              input(
                "Price per generation",
                profile.parameters.pricePerGeneration || 0,
                (v) => {
                  G.getState().set((p) => ({
                    ...p,
                    modelProfiles: p.modelProfiles.map((m) =>
                      m.id === profile.id
                        ? {
                            ...m,
                            parameters: {
                              ...m.parameters,
                              pricePerGeneration: v,
                            },
                          }
                        : m,
                    ),
                  }));
                },
                "number",
              ),
            ),
          ),
        input(
          "Takes per shot",
          settings.takes,
          (v) => save("takes", Math.max(1, Math.min(8, v))),
          "number",
        ),
        input(
          "Maximum attempts",
          settings.attempts,
          (v) => save("attempts", Math.max(1, Math.min(10, v))),
          "number",
        ),
        ...["chain", "autoAudio", "autoDelivery"].map((key) =>
          asEl(
            "label",
            { key },
            asEl("input", {
              type: "checkbox",
              checked: settings[key],
              onChange: (e) => save(key, e.target.checked),
            }),
            {
              chain: "Use previous approved last frame",
              autoAudio: "Generate missing dialogue audio",
              autoDelivery: "Export Delivery Pack after production",
            }[key],
          ),
        ),
        asEl(
          "p",
          {},
          `${plan.jobs} jobs • estimated ${(plan.seconds / 60).toFixed(1)} GPU minutes • estimated spend ${plan.spend.toFixed(2)} • ${(plan.bytes / 1e9).toFixed(2)} GB. Estimates improve from completed jobs.`,
        ),
        ...["references", "keyframes", "videos"].map((stage) =>
          asEl(
            "p",
            { key: stage },
            stage + ": " + plan.tasks.filter((t) => t.stage === stage).length,
          ),
        ),
        button("Check batch health", async () => {
          const result = await asProductionHealth(p, settings, plan);
          setHealth(result);
          setMessage(
            result.problems.length
              ? result.problems.join("\n")
              : "Health checks passed. Browser storage estimate: " +
                  ((result.disk?.quota || 0) / 1e9).toFixed(1) +
                  " GB quota; native disk free space is not available.",
          );
        }),
        button(
          "Start Auto-Produce",
          () => asProductionRun(settings),
          asBatch.active,
        ),
        asBatch.active &&
          asEl(
            "section",
            { role: "status" },
            asEl("progress", { value: asBatch.done, max: asBatch.total || 1 }),
            asEl(
              "p",
              {},
              asBatch.stage +
                " " +
                asBatch.current +
                " " +
                asBatch.done +
                "/" +
                asBatch.total,
            ),
            button(asBatch.paused ? "Resume" : "Pause", () => {
              asBatch.paused = !asBatch.paused;
              asBatchNotify();
            }),
            button("Stop after current job", () => {
              asBatch.stop = true;
            }),
            button("Cancel batch", () => {
              asBatch.controller.abort();
              for (const job of K.getState().jobs.filter(
                (j) => j.status === "running",
              ))
                asCancelGeneration(job.id);
            }),
          ),
        asEl(
          "details",
          {},
          asEl("summary", {}, "Failed jobs and review queue"),
          asEl(
            "pre",
            {},
            JSON.stringify(
              asBatch.failures.length
                ? asBatch.failures
                : state.batch?.failures || [],
              null,
              2,
            ),
          ),
        ),
      ),
    tab === "Review" &&
      shot &&
      asEl(
        "section",
        { className: "astra-take-review" },
        asEl("h2", {}, asProductionCode(p, shot) + " — " + shot.action),
        asEl(
          "p",
          {},
          "Shortcuts: 1–4 approve • R reject/regenerate • N/P next/previous • Space playback • K flag. Only four takes are mounted at once.",
        ),
        asEl(
          "div",
          { className: "flex gap-4" },
          ...[shots[index - 1], shots[index + 1]].filter(Boolean).map((s) =>
            asEl(
              "figure",
              { key: s.id },
              fl(s.image)?.url &&
                asEl("img", {
                  src: fl(s.image).url,
                  loading: "lazy",
                  style: { width: 120, height: 70, objectFit: "contain" },
                }),
              asEl("figcaption", {}, asProductionCode(p, s)),
            ),
          ),
        ),
        asEl(
          "div",
          { className: "flex gap-2" },
          button("Previous", () => setIndex(Math.max(0, index - 1))),
          button("Next", () => setIndex(Math.min(shots.length - 1, index + 1))),
          button("Keyboard help", () => asProductionHelp()),
          button("Fullscreen", () =>
            document.querySelector(".astra-take-review").requestFullscreen?.(),
          ),
          button("Flag for later", () =>
            override("flagged", !state.shots[shot.id]?.flagged),
          ),
        ),
        asEl(
          "div",
          { className: "grid gap-4 lg:grid-cols-2" },
          ...shot.video.versions.slice(page * 4, page * 4 + 4).map((version) =>
            asEl(
              "article",
              { key: version.id },
              asEl("video", {
                src: version.url,
                controls: true,
                loop: true,
                preload: "metadata",
                style: { width: "100%" },
              }),
              asEl(
                "p",
                {},
                version.id +
                  (shot.video.approvedId === version.id ? " — approved" : "") +
                  (state.shots[shot.id]?.rejected?.includes(version.id)
                    ? " — rejected"
                    : ""),
              ),
              button("Approve " + version.id, () =>
                asProductionApprove(shot.id, version.id),
              ),
              button("Run QC", () => asProductionQC(shot.id, version.id)),
            ),
          ),
        ),
        button("Earlier takes", () => setPage(Math.max(0, page - 1))),
        button("Later takes", () =>
          setPage(
            Math.min(
              Math.floor((shot.video.versions.length - 1) / 4),
              page + 1,
            ),
          ),
        ),
        button("Regenerate rejected takes", async () => {
          for (const s of shots.filter(
            (s) => state.shots[s.id]?.rejected?.length,
          ))
            await asProductionGenerate(
              {
                kind: "video",
                target: { shotId: s.id },
                label: asProductionCode(p, s),
                prompt: s.videoPrompt,
              },
              { ...settings, seed: "" },
            );
        }),
        button("Generate another take", () =>
          asProductionGenerate(
            {
              kind: "video",
              target: { shotId: shot.id },
              label: asProductionCode(p, shot),
              prompt: shot.videoPrompt,
            },
            settings,
          ),
        ),
        button("Approve first takes in this scene", async () => {
          for (const s of shots.filter(
            (s) =>
              s.sceneId === shot.sceneId &&
              !s.video.approvedId &&
              s.video.versions.length,
          ))
            await asProductionApprove(s.id, s.video.versions[0].id);
        }),
        input(
          "Extract reference at seconds (blank uses last frame)",
          state.shots[shot.id]?.frameTime || "",
          (v) => override("frameTime", v),
        ),
        button("Use current playback frame", async () => {
          const videos = [
              ...document.querySelectorAll(".astra-take-review video"),
            ],
            video = videos.find((v) => !v.paused) || videos[0];
          if (!video) throw Error("Open a video take first");
          await override("frameTime", video.currentTime);
        }),
        button("Save chosen frame as continuity reference", async () => {
          const version =
            shot.video.versions.find((v) => v.id === shot.video.approvedId) ||
            shot.video.versions.at(-1);
          if (!version) throw Error("No video take");
          const frame = await asProductionFrame(
            version.url,
            state.shots[shot.id]?.frameTime === ""
              ? undefined
              : Number(state.shots[shot.id]?.frameTime),
          );
          await override("derivedFrame", {
            url: frame,
            parentVersionId: version.id,
          });
        }),
        asEl(
          "details",
          {},
          asEl("summary", {}, "Per-shot overrides and references used"),
          select(
            "Model profile override",
            state.shots[shot.id]?.modelProfileId,
            p.modelProfiles,
            (v) => override("modelProfileId", v),
          ),
          input(
            "Takes override",
            state.shots[shot.id]?.takes || settings.takes,
            (v) => override("takes", Math.max(1, Math.min(8, v))),
            "number",
          ),
          select(
            "Keyframe workflow override",
            state.shots[shot.id]?.workflowImage,
            workflows,
            (v) => override("workflowImage", v),
          ),
          asEl(
            "label",
            {},
            asEl("input", {
              type: "checkbox",
              checked: state.shots[shot.id]?.chain ?? settings.chain,
              onChange: (e) => override("chain", e.target.checked),
            }),
            "Chain previous approved frame",
          ),
          select(
            "Video workflow override",
            state.shots[shot.id]?.workflowVideo,
            workflows,
            (v) => override("workflowVideo", v),
          ),
          input("Seed override", state.shots[shot.id]?.seed, (v) =>
            override("seed", v),
          ),
          input("LoRA override", state.shots[shot.id]?.lora, (v) =>
            override("lora", v),
          ),
          input(
            "Negative prompt override",
            state.shots[shot.id]?.negative,
            (v) => override("negative", v),
          ),
          asEl(
            "p",
            {},
            JSON.stringify(state.shots[shot.id]?.referencesUsed || []),
          ),
        ),
      ),
    tab === "Audio" &&
      asEl(
        "section",
        { className: "grid gap-3" },
        asEl("h2", {}, "Voices and dialogue assets"),
        select("Default TTS adapter", settings.ttsApiId, apis, (v) =>
          save("ttsApiId", v),
        ),
        select("Optional lip-sync adapter", settings.lipSyncApiId, apis, (v) =>
          save("lipSyncApiId", v),
        ),
        ...p.characters.map((character) =>
          asEl(
            "details",
            { key: character.id },
            asEl("summary", {}, character.name + " voice"),
            select(
              "ComfyUI voice workflow (optional)",
              state.voices[character.name]?.workflowId,
              workflows,
              (v) =>
                asProductionSave((d) => ({
                  ...d,
                  voices: {
                    ...d.voices,
                    [character.name]: {
                      ...d.voices[character.name],
                      workflowId: v,
                    },
                  },
                })),
            ),
            select(
              "Voice provider adapter",
              state.voices[character.name]?.apiId,
              apis,
              (v) =>
                asProductionSave((d) => ({
                  ...d,
                  voices: {
                    ...d.voices,
                    [character.name]: { ...d.voices[character.name], apiId: v },
                  },
                })),
            ),
            asEl(
              "label",
              {},
              "Voice reference audio",
              asEl("input", {
                type: "file",
                accept: "audio/*",
                onChange: act(async (e) => {
                  const reference = await asMediaPut(e.target.files[0]);
                  await asProductionSave((d) => ({
                    ...d,
                    voices: {
                      ...d.voices,
                      [character.name]: {
                        ...d.voices[character.name],
                        reference,
                      },
                    },
                  }));
                }),
              }),
            ),
            input("Voice ID", state.voices[character.name]?.voiceId, (v) =>
              asProductionSave((d) => ({
                ...d,
                voices: {
                  ...d.voices,
                  [character.name]: { ...d.voices[character.name], voiceId: v },
                },
              })),
            ),
            input(
              "Language",
              state.voices[character.name]?.language || "te",
              (v) =>
                asProductionSave((d) => ({
                  ...d,
                  voices: {
                    ...d.voices,
                    [character.name]: {
                      ...d.voices[character.name],
                      language: v,
                    },
                  },
                })),
            ),
            input(
              "Speed",
              state.voices[character.name]?.speed || 1,
              (v) =>
                asProductionSave((d) => ({
                  ...d,
                  voices: {
                    ...d.voices,
                    [character.name]: { ...d.voices[character.name], speed: v },
                  },
                })),
              "number",
            ),
          ),
        ),
        button("Generate missing dialogue audio", asAudioAll),
        ...shots.slice(page * 10, page * 10 + 10).map((s) =>
          asEl(
            "details",
            { key: s.id },
            asEl("summary", {}, asProductionCode(p, s) + " dialogue"),
            ...s.dialogue.map((line, i) =>
              asEl(
                "div",
                { key: i },
                asEl(
                  "p",
                  {},
                  line.lang + " • " + line.character + ": " + line.line,
                ),
                input(
                  "Line offset (seconds)",
                  state.shots[s.id]?.lineOffsets?.[i] || 0,
                  (v) =>
                    asProductionSave((d) => ({
                      ...d,
                      shots: {
                        ...d.shots,
                        [s.id]: {
                          ...d.shots[s.id],
                          lineOffsets: {
                            ...d.shots[s.id]?.lineOffsets,
                            [i]: v,
                          },
                        },
                      },
                    })),
                  "number",
                ),
                button("Generate / Regenerate line " + (i + 1), () =>
                  asAudioLine(s.id, i),
                ),
                asEl(
                  "label",
                  {},
                  "Upload my own audio",
                  asEl("input", {
                    type: "file",
                    accept: "audio/*",
                    onChange: act((e) =>
                      asAudioUpload(e.target.files[0], s, i),
                    ),
                  }),
                ),
                state.audio.find((a) => a.lineKey === s.id + ":" + i) &&
                  asEl("audio", {
                    controls: true,
                    preload: "none",
                    src: state.audio.find((a) => a.lineKey === s.id + ":" + i)
                      .url,
                  }),
              ),
            ),
            button("Lip-sync approved clip (provider dependent)", () =>
              asProductionLipSync(s.id),
            ),
          ),
        ),
        button("Previous audio page", () => setPage(Math.max(0, page - 1))),
        button("Next audio page", () =>
          setPage(Math.min(Math.floor(shots.length / 10), page + 1)),
        ),
        select(
          "Audio cue category",
          settings.audioSection || "scratch",
          [
            { id: "scratch", name: "Scratch" },
            { id: "music", name: "Music" },
            { id: "sfx", name: "SFX" },
          ],
          (v) => save("audioSection", v),
        ),
        asEl(
          "label",
          {},
          "Upload music / SFX / scratch",
          asEl("input", {
            type: "file",
            accept: "audio/*",
            onChange: act(async (e) => {
              const file = e.target.files[0];
              if (!file.type.startsWith("audio/")) throw Error("Choose audio");
              const url = await asMediaPut(file);
              await asProductionSave((d) => ({
                ...d,
                cues: [
                  ...d.cues,
                  {
                    id: Zc("cue"),
                    name: file.name.replace(/\.[^.]+$/, ""),
                    url,
                    section: settings.audioSection || "scratch",
                  },
                ],
              }));
            }),
          }),
        ),
        asEl(
          "p",
          {},
          "Sound cues: " +
            shots
              .map((s) => s.soundCue)
              .filter(Boolean)
              .join(" • "),
        ),
      ),
    tab === "QC & Post" &&
      asEl(
        "section",
        { className: "grid gap-3" },
        asEl("h2", {}, "Quality and clip-length plan"),
        asEl(
          "p",
          {},
          "QC uses sampled pixels. Identity drift and frozen-frame flags are heuristics; provider FPS is used when known.",
        ),
        input(
          "Duration tolerance (fraction)",
          settings.qcTolerance,
          (v) => save("qcTolerance", Math.max(0.01, v)),
          "number",
        ),
        asEl(
          "label",
          {},
          asEl("input", {
            type: "checkbox",
            checked: !!settings.autoPost,
            onChange: (e) => save("autoPost", e.target.checked),
          }),
          "Run post-process workflow after approval",
        ),
        input(
          "ComfyUI video upload endpoint path",
          settings.videoUploadPath || "",
          (v) => {
            save("videoUploadPath", v);
            K.getState().update({
              comfy: connections.map((c) =>
                c.id === settings.serverId ? { ...c, uploadVideoPath: v } : c,
              ),
            });
          },
        ),
        select(
          "Post-process workflow (upscale / interpolate / conform)",
          settings.postWorkflowId,
          workflows,
          (v) => save("postWorkflowId", v),
        ),
        button("QC all unmeasured takes", async () => {
          for (const s of shots)
            for (const v of s.video.versions)
              if (!state.shots[s.id]?.qc?.[v.id])
                await asProductionQC(s.id, v.id);
        }),
        ...shots.slice(page * 20, page * 20 + 20).map((s) =>
          asEl(
            "details",
            { key: s.id },
            asEl(
              "summary",
              {},
              asProductionCode(p, s) + " " + s.duration + "s",
            ),
            asEl(
              "pre",
              {},
              JSON.stringify(state.shots[s.id]?.qc || {}, null, 2),
            ),
            button("Suggest highest-scoring take", async () => {
              const best = Object.entries(state.shots[s.id]?.qc || {}).sort(
                (a, b) => b[1].score - a[1].score,
              )[0];
              if (!best) throw Error("Run QC first");
              await asProductionApprove(s.id, best[0]);
            }),
            button("Process approved take", () =>
              asProductionGenerate(
                {
                  stage: "post",
                  kind: "video",
                  target: { shotId: s.id },
                  label: "Post-process " + asProductionCode(p, s),
                  prompt: s.videoPrompt,
                },
                { ...settings, workflowVideo: settings.postWorkflowId },
              ),
            ),
          ),
        ),
        asEl(
          "p",
          {},
          "Segment jobs (first 100): " +
            plan.tasks
              .filter((t) => t.segment)
              .slice(0, 100)
              .map((t) => t.label + " " + t.segment.duration + "s")
              .join(" • "),
        ),
        button("Previous QC page", () => setPage(Math.max(0, page - 1))),
        button("Next QC page", () =>
          setPage(Math.min(Math.floor((shots.length - 1) / 20), page + 1)),
        ),
      ),
    tab === "Animatic & Revisions" &&
      asEl(
        "section",
        { className: "grid gap-3" },
        asEl("h2", {}, "Animatic and revision diff"),
        asEl(
          "label",
          {},
          asEl("input", {
            type: "checkbox",
            checked: !!settings.scratchAudio,
            onChange: (e) => save("scratchAudio", e.target.checked),
          }),
          "Use uploaded scratch audio bed",
        ),
        button("Export timed animatic review", () =>
          asRenderAssembly({
            project: p,
            shots,
            signal: new AbortController().signal,
            onStatus: setMessage,
          }),
        ),
        asEl(
          "p",
          {},
          "Uses the existing timed still/video renderer. Source-video audio remains a review reference.",
        ),
        button("Save current script revision baseline", () =>
          asProductionSave((d) => ({
            ...d,
            revision: {
              script: p.script,
              scenes: p.scenes.map((s) => ({
                id: s.id,
                slug: s.slug,
                text: s.text,
              })),
              createdAt: Date.now(),
            },
          })),
        ),
        asEl("pre", {}, JSON.stringify(asRevisionDiff(p), null, 2)),
        button("Select changed scenes for regeneration", () =>
          save("sceneIds", asRevisionDiff(p).changed).then(async () => {
            await save("scope", "selected");
            await save("regenerateScenes", asRevisionDiff(p).changed);
          }),
        ),
      ),
    tab === "Final checklist" &&
      asEl(
        "section",
        { className: "grid gap-3" },
        asEl("h2", {}, "Final checklist"),
        asEl(
          "p",
          {},
          `${p.shots.filter((s) => s.video.approvedId).length}/${p.shots.length} shots approved`,
        ),
        asEl(
          "p",
          {},
          `${state.audio.length}/${p.shots.reduce((n, s) => n + s.dialogue.length, 0)} dialogue lines voiced`,
        ),
        asEl(
          "p",
          {},
          `${
            Object.values(state.shots)
              .flatMap((s) => Object.values(s.qc || {}))
              .filter((q) => q.flags.length).length
          } takes with QC flags`,
        ),
        button("Verify exported files against manifest", async () => {
          const result = await asProductionVerify();
          setMessage(
            result.failures.length
              ? result.failures.join("\n")
              : "Verified " + result.files + " exported files",
          );
        }),
        button("Export Delivery Pack", () =>
          asDeliveryRun(asDeliveryProject(p, "delivery"), {
            scope: "delivery",
          }),
        ),
        button("Export Everything", () =>
          asDeliveryRun(asDeliveryProject(p, "everything"), {
            scope: "everything",
          }),
        ),
      ),
  );
}
async function asProductionInit() {}
function asProductionDataSchema() {
  return wc({
    settings: wc({
      takes: xc().int().min(1).max(8).optional(),
      attempts: xc().int().min(1).max(10).optional(),
    })
      .passthrough()
      .optional(),
    shots: wc({}).catchall(wc({}).passthrough()).optional(),
    voices: wc({}).catchall(wc({}).passthrough()).optional(),
    audio: Cc(
      wc({
        id: U(),
        url: U(),
        shotId: U().optional(),
        lineKey: U().optional(),
      }).passthrough(),
    ).optional(),
    cues: Cc(wc({ id: U(), url: U() }).passthrough()).optional(),
    timings: wc({}).passthrough().optional(),
    revision: wc({}).passthrough().nullable().optional(),
    batch: wc({}).passthrough().nullable().optional(),
  })
    .passthrough()
    .optional();
}

const asProductionJSONSchema = {
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
    schemaVersion: { const: 3 },
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
  },
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ASTRA Studio production project v3",
  description:
    "Version 3 adds optional local production pipeline records. Versions 1 and 2 remain importable.",
};

function asProductionHelp() {
  const dialog = document.createElement("dialog");
  dialog.className = "astra-delivery-dialog";
  const title = document.createElement("h2");
  title.textContent = "Take review keyboard shortcuts";
  const text = document.createElement("p");
  text.textContent =
    "1–4 approve a visible take. R rejects and regenerates. N / P move to next / previous shot. Space toggles playback. K flags for later. Escape closes dialogs or exits fullscreen. Use the native video scrubber and Use current playback frame to choose a continuity reference.";
  const close = document.createElement("button");
  close.textContent = "Close";
  close.onclick = () => dialog.close();
  dialog.append(title, text, close);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
}
