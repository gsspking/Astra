/* Durable monitoring records contain no API credentials. Connections retain their existing vault. */
let asJobJournal = Promise.resolve();
function asSaveJobs() {
  const jobs = K.getState().jobs.map((job) => ({ ...job }));
  const write = asJobJournal
    .catch(() => {})
    .then(() => {
      if (_l() && !vl())
        throw Error("Unlock the local vault before running jobs");
      return Vl.setItem("astra-job-journal", JSON.stringify(jobs));
    });
  asJobJournal = write;
  return write;
}
async function asResumeJob(id) {
  const job = K.getState().jobs.find((j) => j.id === id);
  if (!job?.remoteId || !job.serverUrl || job.provider !== "comfyui")
    throw Error("This job has no resumable ComfyUI prompt ID");
  if (asJobControllers.has(id)) throw Error("Already monitoring this job");
  const controller = new AbortController(),
    run = { id, job, controller };
  asJobControllers.set(id, controller);
  K.getState().patchJob(id, {
    status: "running",
    log: "Resuming provider monitoring…",
  });
  await asSaveJobs();
  const stop = K.subscribe((s) => {
    if (s.jobs.find((j) => j.id === id)?.status === "cancelled")
      controller.abort();
  });
  try {
    await asMonitorJob(run);
    return K.getState().jobs.find((j) => j.id === id);
  } catch (e) {
    if (controller.signal.aborted)
      await fetch(job.serverUrl.replace(/\/$/, "") + "/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [job.remoteId] }),
      }).catch(() => {});
    K.getState().patchJob(id, {
      status: controller.signal.aborted ? "cancelled" : "failed",
      log: e.message,
    });
    await asSaveJobs();
    throw e;
  } finally {
    stop();
    asJobControllers.delete(id);
  }
}
async function asMonitorJob(run) {
  const { job, id, controller } = run,
    signal = controller.signal,
    base = job.serverUrl.replace(/\/$/, ""),
    timeout =
      Number(
        K.getState().jobTimeouts?.[job.kind] ||
          (job.kind === "video" ? 14400 : 3600),
      ) * 1000,
    started = Date.now();
  while (Date.now() - started < timeout) {
    signal.throwIfAborted();
    let response;
    try {
      response = await fetch(
        base + "/history/" + encodeURIComponent(job.remoteId),
        { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) },
      );
      if (response.status >= 500) throw Error("HTTP " + response.status);
    } catch (e) {
      if (signal.aborted) throw e;
      asPipelineRuntime.waiting = true;
      asPipelineNotify();
      const deadline = Date.now() + asHardware().giveUpSeconds * 1000;
      let retry = 0;
      while (Date.now() < deadline) {
        await asPipelineDelay(
          Math.min(15000, 500 * 2 ** Math.min(retry++, 5)),
          signal,
        );
        try {
          response = await fetch(
            base + "/history/" + encodeURIComponent(job.remoteId),
            { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) },
          );
          if (response.ok) break;
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
      asPipelineRuntime.waiting = false;
      asPipelineNotify();
      if (!response?.ok)
        throw Error(
          "ComfyUI unreachable past recovery deadline. Resume monitoring prompt " +
            job.remoteId +
            "; do not submit a replacement.",
        );
    }
    if (!response.ok) throw Error("ComfyUI history HTTP " + response.status);
    const entry = (await response.json())[job.remoteId];
    if (
      entry?.status?.status_str === "error" ||
      entry?.status?.messages?.some((m) => m[0] === "execution_error")
    )
      throw Error(
        "ComfyUI execution failed: " +
          JSON.stringify(entry.status.messages || entry.status),
      );
    if (entry) {
      const output = Object.values(entry.outputs || {}).flatMap((o) => [
        ...(o.videos || []),
        ...(o.gifs || []),
        ...(o.images || []),
        ...(o.audio || []),
      ])[0];
      if (output) {
        const response = await fetch(
          base +
            "/view?" +
            new URLSearchParams({
              filename: output.filename,
              subfolder: output.subfolder || "",
              type: output.type || "output",
            }),
          { signal },
        );
        if (!response.ok) throw Error("ComfyUI output HTTP " + response.status);
        await asCompleteGeneration(
          run,
          await asMediaPut(await response.blob()),
          "comfyui",
        );
        await asSaveJobs();
        return;
      }
      if (entry.status?.completed)
        throw Error("ComfyUI completed without usable output");
    }
    K.getState().patchJob(id, {
      log: "Still running on ComfyUI; monitoring " + job.remoteId,
    });
    await asPipelineDelay(2000, signal);
  }
  throw Error(
    "Monitoring timed out. The remote job may still be running; Resume monitoring will reconnect without submitting a duplicate.",
  );
}
async function asJobHealth(server, workflow) {
  const problems = [];
  const base = server?.url?.replace(/\/$/, "");
  if (!base) return ["Choose a ComfyUI server"];
  try {
    const response = await fetch(base + "/object_info", {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("HTTP " + response.status);
    const nodes = await response.json();
    let graph;
    try {
      graph = JSON.parse(workflow?.json || "{}");
    } catch {
      throw Error("Workflow is not valid JSON");
    }
    if (!Object.keys(graph).length)
      problems.push("Choose a nonempty API-format workflow");
    for (const [id, node] of Object.entries(graph)) {
      const spec = nodes[node.class_type];
      if (!spec) {
        problems.push("Missing node " + node.class_type + " (" + id + ")");
        continue;
      }
      for (const [key, value] of Object.entries(node.inputs || {})) {
        const allowed = (spec.input?.required?.[key] ||
          spec.input?.optional?.[key])?.[0];
        if (
          Array.isArray(allowed) &&
          typeof value === "string" &&
          !value.includes("{{") &&
          !allowed.includes(value)
        )
          problems.push(
            node.class_type +
              "." +
              key +
              ": model or option not installed: " +
              value,
          );
      }
    }
  } catch (e) {
    problems.push("ComfyUI health check: " + e.message);
  }
  return problems;
}
function asJobsPanel() {
  const connections = K((s) => s.comfy),
    workflows = K((s) => s.workflows),
    jobs = K((s) => s.jobs),
    timeouts = K((s) => s.jobTimeouts) || {},
    [message, setMessage] = j.useState("");
  const resumable = jobs.filter(
    (job) =>
      job.provider === "comfyui" &&
      job.remoteId &&
      !job.attached &&
      !asJobControllers.has(job.id) &&
      ["running", "queued", "failed", "saving"].includes(job.status),
  );
  return asEl(
    "section",
    {
      className:
        "astra-delivery-panel grid gap-3 rounded-lg border border-border bg-card p-4",
    },
    asEl("h2", { className: "font-semibold" }, "Job recovery"),
    asEl(
      "p",
      {},
      "Resume monitoring reconnects to an existing prompt without submitting it again. Running remote work may continue after local cancellation.",
    ),
    ...["image", "video"].map((kind) =>
      asEl(
        "label",
        { key: kind },
        kind + " monitoring timeout (seconds)",
        asEl("input", {
          className: "field",
          type: "number",
          min: 60,
          value: timeouts[kind] || (kind === "video" ? 14400 : 3600),
          onChange: (e) =>
            K.getState().update({
              jobTimeouts: {
                ...timeouts,
                [kind]: Math.max(60, Number(e.target.value) || 60),
              },
            }),
        }),
      ),
    ),
    ...resumable.slice(0, 30).map((job) =>
      asEl(
        "div",
        { key: job.id },
        asEl("span", {}, job.projectTitle + " — " + job.label + " "),
        asEl(
          Z,
          {
            onClick: async () => {
              try {
                await asResumeJob(job.id);
                setMessage(
                  "Monitoring completed; inspect the job queue for attachment status.",
                );
              } catch (e) {
                setMessage(e.message);
              }
            },
          },
          "Resume monitoring",
        ),
      ),
    ),
    ...connections.map((server) =>
      asEl(
        Z,
        {
          key: server.id,
          onClick: async () => {
            const errors = [];
            if (!workflows.length) errors.push("No workflows configured");
            for (const workflow of workflows)
              errors.push(
                ...(await asJobHealth(server, workflow)).map(
                  (e) => workflow.name + ": " + e,
                ),
              );
            setMessage(
              errors.length
                ? errors.join("\n")
                : "ComfyUI nodes and model choices are available.",
            );
          },
        },
        "Check " + server.name + " workflows",
      ),
    ),
    asEl("p", { role: "status", style: { whiteSpace: "pre-wrap" } }, message),
  );
}
async function asJobsInit() {
  try {
    if (!K.persist.hasHydrated())
      await new Promise((resolve) => {
        const off = K.persist.onFinishHydration(() => {
          off();
          resolve();
        });
      });
    const raw = await Vl.getItem("astra-job-journal"),
      saved = raw ? JSON.parse(raw) : null;
    if (Array.isArray(saved)) {
      const byId = new Map(K.getState().jobs.map((j) => [j.id, j]));
      for (const job of saved)
        if (!asJobControllers.has(job.id)) byId.set(job.id, job);
      K.getState().update({ jobs: [...byId.values()] });
    }
    K.subscribe((next, previous) => {
      if (next.jobs !== previous.jobs)
        asSaveJobs().catch((e) =>
          i_.error("Job recovery could not be saved: " + e.message),
        );
    });
  } catch (e) {
    i_.error("Job recovery could not load: " + e.message);
  }
}
