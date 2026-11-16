const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  http = require("node:http");
const { chromium } = require("playwright");
let browser, server, base;
before(async () => {
  const html = fs
    .readFileSync("index.html", "utf8")
    .replace(
      "</script>",
      "window.__p={G,K,Kl,Uc,asLLMRequest,asLLMStop,asJSONExtract,asEstimateTokens,asPassBudget,asAnalysisRun,asAnalysisAccept,asPipelineRun,asPipelineRuntime,asPipelineSave,asPipelineData,asProduction,asProductionSave,asProductionPlan,asProductionRun,asBatch,asHardwareToComfy,asHardwareToLLM,asSampleScreenplay,asSelfTests,asDelivery,asErrorClass,asStageFingerprint,asLLMContextProbe,asRedact,asAttachGeneration};</script>",
    );
  server = http.createServer((q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});
async function session(t) {
  const p = await browser.newPage();
  t.after(() => p.close());
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await p.goto(base + "#/auto-produce");
  await p.waitForFunction(
    () =>
      window.__p?.G.getState().hydrated && window.__p.Kl.getState().activeId,
  );
  return p;
}
test("OpenAI streaming assembles deltas and detects length truncation", async (t) => {
  const p = await session(t);
  let body;
  await p.route("https://llm.test/**", async (route) => {
    body = JSON.parse(route.request().postData());
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"choices":[{"delta":{"content":"{\\\"ok\\\":"}}]}\n\ndata: {"choices":[{"delta":{"content":"true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\ndata: [DONE]\n\n',
    });
  });
  const result = await p.evaluate(() =>
    window.__p.asLLMRequest(
      {
        id: "test",
        kind: "openai",
        name: "Fixture",
        baseUrl: "https://llm.test/v1",
        model: "fixture",
        maxOutputTokens: 99,
        contextWindow: 1024,
        streaming: true,
      },
      "system",
      "user",
      { schema: { type: "object" } },
    ),
  );
  assert.equal(JSON.parse(result).ok, true);
  assert.equal(body.max_tokens, 99);
  assert.equal(body.response_format.type, "json_schema");
  await p.unroute("https://llm.test/**");
  await p.route("https://llm.test/**", (r) =>
    r.fulfill({
      json: {
        choices: [
          { message: { content: '{"partial":' }, finish_reason: "length" },
        ],
      },
    }),
  );
  await assert.rejects(
    p.evaluate(() =>
      window.__p.asLLMRequest(
        {
          id: "test",
          kind: "openai",
          baseUrl: "https://llm.test/v1",
          model: "fixture",
          streaming: false,
        },
        "s",
        "u",
      ),
    ),
    /truncated/,
  );
});
test("Ollama native NDJSON uses context/output settings and preserves Telugu", async (t) => {
  const p = await session(t);
  let body, url;
  await p.route("https://ollama.test/**", async (route) => {
    url = route.request().url();
    body = JSON.parse(route.request().postData());
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({ message: { content: '{"line":"తెలుగు"}' } }) +
        "\n" +
        JSON.stringify({
          done: true,
          done_reason: "stop",
          prompt_eval_count: 20,
          eval_count: 8,
        }) +
        "\n",
    });
  });
  const result = await p.evaluate(() =>
    window.__p.asLLMRequest(
      {
        id: "ollama",
        kind: "ollama",
        baseUrl: "https://ollama.test/v1",
        model: "local",
        contextWindow: 4096,
        maxOutputTokens: 512,
      },
      "Return JSON",
      "తెలుగు",
    ),
  );
  assert.equal(JSON.parse(result).line, "తెలుగు");
  assert.equal(url, "https://ollama.test/api/chat");
  assert.equal(body.options.num_ctx, 4096);
  assert.equal(body.options.num_predict, 512);
});
test("timeout aborts a long LLM request and does not return partial success", async (t) => {
  const p = await session(t);
  await p.route("https://slow.test/**", async () => {});
  await assert.rejects(
    p.evaluate(() =>
      window.__p.asLLMRequest(
        {
          id: "slow",
          kind: "openai",
          baseUrl: "https://slow.test/v1",
          model: "slow",
          timeoutSeconds: 0.05,
        },
        "s",
        "u",
      ),
    ),
    /timeout/i,
  );
});
test("handoff verifies Ollama unload before Comfy free/VRAM", async (t) => {
  const p = await session(t),
    calls = [];
  await p.route("https://gpu.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    await route.fulfill({
      json:
        path === "/api/ps"
          ? { models: [] }
          : path === "/system_stats"
            ? {
                devices: [
                  { vram_total: 12 * 2 ** 30, vram_free: 10 * 2 ** 30 },
                ],
              }
            : {},
    });
  });
  await p.evaluate(async () => {
    const x = window.__p;
    x.K.getState().update({
      comfy: [{ id: "gpu", url: "https://gpu.test" }],
      hardware: { singleGPU: true, thresholdGB: 4 },
    });
    await x.asProductionSave((d) => ({
      ...d,
      settings: { ...d.settings, serverId: "gpu" },
    }));
    await x.asHardwareToComfy({
      id: "ollama",
      kind: "ollama",
      baseUrl: "https://gpu.test/v1",
      model: "local",
    });
  });
  assert.ok(calls.indexOf("/api/generate") < calls.indexOf("/api/ps"));
  assert.ok(calls.indexOf("/api/ps") < calls.indexOf("/free"));
  assert.equal(calls.at(-1), "/system_stats");
});
test("skill routing drops low-priority skills explicitly and budgets Telugu conservatively", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(() => {
    const x = window.__p,
      p = structuredClone(x.G.getState().project);
    p.skills = [
      { id: "sound", name: "Sound", type: "sound", body: "x".repeat(2000) },
      {
        id: "analysis",
        name: "Analyze",
        roles: ["analysis"],
        body: "A".repeat(2500),
      },
    ];
    p.meta.skillIds = ["sound", "analysis"];
    const budget = x.asPassBudget(
      p,
      { id: "small", contextWindow: 1000, maxOutputTokens: 200 },
      1,
      { text: "తెలుగు" },
    );
    return {
      budget,
      telugu: x.asEstimateTokens("తెలుగు"),
      english: x.asEstimateTokens("telugu"),
    };
  });
  assert.ok(!result.budget.system.includes("Sound"));
  assert.ok(result.budget.cuts.some((c) => c.includes("Analyze")));
  assert.ok(result.telugu > result.english);
});
test("offline self-tests execute and manual pipeline does nothing until run", async (t) => {
  const p = await session(t);
  const data = await p.evaluate(async () => ({
    tests: await window.__p.asSelfTests(),
    stages: window.__p.asPipelineData().stages,
    active: window.__p.asPipelineRuntime.active,
  }));
  assert.ok(data.tests.every((t) => t.status === "pass"));
  assert.deepEqual(data.stages, {});
  assert.equal(data.active, false);
});
test(
  "full-auto simulation runs three bilingual scenes to a labelled Delivery Pack",
  { timeout: 120000 },
  async (t) => {
    const p = await session(t);
    const requests = [];
    await p.route("**/*", async (route) => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      requests.push(u);
      return route.abort();
    });
    const result = await p.evaluate(async () => {
      const x = window.__p;
      await x.asDelivery.ready;
      const root = await navigator.storage.getDirectory();
      x.asDelivery.handle = {
        queryPermission: async () => "granted",
        getDirectoryHandle: (...a) => root.getDirectoryHandle(...a),
        getFileHandle: (...a) => root.getFileHandle(...a),
        removeEntry: (...a) => root.removeEntry(...a),
      };
      x.K.getState().update({
        simulation: { enabled: true, latencyMs: 1 },
        llm: [
          {
            id: "sim",
            kind: "simulation",
            name: "SIMULATION",
            model: "simulation",
            contextWindow: 16384,
            maxOutputTokens: 1024,
          },
        ],
        activeLlmId: "sim",
      });
      x.G.getState().replace({
        ...x.G.getState().project,
        script: x.asSampleScreenplay,
        scriptElements: [],
        shots: [],
        scenes: [],
      });
      await x.asProductionSave((d) => ({
        ...d,
        settings: { ...d.settings, takes: 1 },
      }));
      await x.asPipelineSave((d) => ({
        ...d,
        mode: "full-auto",
        simulation: true,
        enabled: d.enabled.map((v, i) => (i === 7 ? true : v)),
      }));
      try {
        await x.asPipelineRun();
      } catch (e) {
        throw Error(
          e.message + JSON.stringify(x.asProduction().batch?.failures),
        );
      }
      return {
        stages: x.asPipelineData().stages,
        shots: x.G.getState().project.shots.map((s) => ({
          dialogue: s.dialogue,
          videos: s.video.versions,
        })),
        delivery: x.asDelivery.report,
        report: x.asPipelineData().morningReport,
      };
    });
    assert.equal(requests.length, 0);
    assert.equal(result.stages[0].status, "done");
    assert.equal(result.stages[8].status, "done");
    assert.equal(result.shots.length, 3);
    assert.ok(result.shots.every((s) => s.videos.length === 1));
    assert.ok(
      result.shots.some((s) => s.dialogue.some((l) => l.lang === "te")),
    );
    assert.equal(result.delivery.complete, true);
    assert.match(result.report, /SIMULATION/);
  },
);
test(
  "60-scene analysis resumes checkpoints with stable scene IDs and no Telugu loss",
  { timeout: 120000 },
  async (t) => {
    const p = await session(t);
    const result = await p.evaluate(async () => {
      const x = window.__p;
      x.K.getState().update({
        simulation: { enabled: true, latencyMs: 0 },
        hardware: { singleGPU: false },
        llm: [
          {
            id: "sim",
            kind: "simulation",
            model: "simulation",
            contextWindow: 32768,
            maxOutputTokens: 1024,
          },
        ],
        activeLlmId: "sim",
      });
      const script = Array.from(
        { length: 60 },
        (_, i) =>
          "INT. ROOM " +
          i +
          " - DAY\n\nA person waits.\n\nRAVI\nనమస్తే " +
          i +
          ".\n",
      ).join("\n");
      const project = {
        ...x.G.getState().project,
        script,
        scriptElements: [],
        shots: [],
        scenes: [],
        pipeline: undefined,
      };
      const c = new AbortController();
      let stopped = false,
        startedScenes = 0;
      try {
        await x.asAnalysisRun(project, {
          signal: c.signal,
          onStatus: (status) => {
            if (status.startsWith("Pass 1 ") && ++startedScenes === 6)
              c.abort();
          },
        });
      } catch (e) {
        stopped = true;
      }
      const candidate = await x.asAnalysisRun(project);
      const checkpoints = x.asPipelineRuntime.log.filter(
        (e) =>
          e.stage === "analysis" && e.result === "checkpoint" && e.pass === 1,
      );
      return {
        stopped,
        scenes: candidate.scenes.length,
        dialogue: candidate.shots.flatMap((s) => s.dialogue).length,
        te: candidate.shots
          .flatMap((s) => s.dialogue)
          .every((l) => l.lang === "te"),
        checkpoints: checkpoints.length,
        unique: new Set(checkpoints.map((c) => c.key)).size,
      };
    });
    assert.equal(result.stopped, true);
    assert.equal(result.scenes, 60);
    assert.equal(result.dialogue, 60);
    assert.equal(result.te, true);
    assert.equal(result.checkpoints, result.unique);
  },
);
test("guided mode waits at Analyze gate and merges only after Continue", async (t) => {
  const p = await session(t);
  await p.evaluate(async () => {
    const x = window.__p;
    x.K.getState().update({
      simulation: { enabled: true, latencyMs: 0 },
      llm: [
        {
          id: "sim",
          kind: "simulation",
          model: "simulation",
          contextWindow: 16384,
          maxOutputTokens: 1024,
        },
      ],
      activeLlmId: "sim",
    });
    x.G.getState().replace({
      ...x.G.getState().project,
      script: x.asSampleScreenplay,
      scriptElements: [],
      shots: [],
      scenes: [],
    });
    await x.asPipelineSave((d) => ({
      ...d,
      mode: "guided",
      gates: [0],
      enabled: d.enabled.map((_, i) => i === 0),
    }));
    window.pipelinePending = x.asPipelineRun();
  });
  await p.waitForFunction(() => window.__p.asPipelineRuntime.gate?.index === 0);
  assert.equal(
    await p.evaluate(() => window.__p.G.getState().project.shots.length),
    0,
  );
  await p.getByRole("button", { name: "Continue", exact: true }).click();
  await p.evaluate(() => window.pipelinePending);
  assert.equal(
    await p.evaluate(() => window.__p.G.getState().project.shots.length),
    3,
  );
});
test("permanent simulation failures are not retried and cannot report Finished", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__p,
      p = structuredClone(x.G.getState().project);
    p.characters = [];
    p.props = [];
    p.costumes = [];
    p.environments = [];
    p.shots = p.shots.slice(0, 1);
    p.shots[0].image = {
      approvedId: "i",
      versions: [{ id: "i", url: "data:image/png;base64,AA==" }],
    };
    p.shots[0].video = { approvedId: null, versions: [] };
    p.shots[0].imagePrompt = "A valid keyframe";
    p.shots[0].videoPrompt = "A valid moving shot";
    x.G.getState().replace(p);
    x.K.getState().update({
      simulation: { enabled: true, permanentPercent: 100 },
    });
    await x.asProductionRun({
      ...x.asProduction().settings,
      takes: 1,
      attempts: 3,
    });
    return {
      jobs: x.K.getState().jobs.length,
      batch: x.asProduction().batch,
      done: x.asBatch.done,
    };
  });
  assert.equal(result.jobs, 1);
  assert.equal(result.batch.finished, false);
  assert.equal(result.batch.failures.length, 1);
  assert.equal(result.done, 0);
  assert.match(result.batch.status, /1 failures/);
});
test("out-of-memory frees once and retries exactly once even when attempts is one", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__p,
      p = structuredClone(x.G.getState().project);
    p.characters = [];
    p.props = [];
    p.costumes = [];
    p.environments = [];
    p.shots = p.shots.slice(0, 1);
    p.shots[0].imagePrompt = "A keyframe";
    p.shots[0].videoPrompt = "A moving shot";
    p.shots[0].image = {
      approvedId: "i",
      versions: [{ id: "i", url: "data:image/png;base64,AA==" }],
    };
    p.shots[0].video = { approvedId: null, versions: [] };
    x.G.getState().replace(p);
    x.K.getState().update({ simulation: { enabled: true, oomPercent: 100 } });
    await x.asProductionRun({
      ...x.asProduction().settings,
      takes: 1,
      attempts: 1,
    });
    return {
      jobs: x.K.getState().jobs.length,
      batch: x.asProduction().batch,
      frees: x.asPipelineRuntime.log.filter((e) => e.stage === "comfy-free")
        .length,
    };
  });
  assert.equal(result.jobs, 2);
  assert.equal(result.frees, 1);
  assert.match(result.batch.failures[0].reason, /Needs lower settings/);
  assert.equal(result.batch.finished, false);
});
test("script edits mark downstream stages stale without deleting approved media", async (t) => {
  const p = await session(t);
  await p.evaluate(async () => {
    const x = window.__p,
      shot = x.G.getState().project.shots[0];
    x.G.getState().updateShot(shot.id, {
      video: {
        approvedId: "approved",
        versions: [{ id: "approved", url: "data:video/webm;base64,AA==" }],
      },
    });
    await x.asPipelineSave((d) => ({
      ...d,
      stages: { 4: { status: "done", fingerprint: undefined } },
    }));
    const hash = await x.asStageFingerprint(4);
    await x.asPipelineSave((d) => ({
      ...d,
      stages: { 4: { status: "done", fingerprint: hash } },
    }));
    x.G.getState().set((p) => ({ ...p, script: p.script + "\nA new action." }));
  });
  await p.waitForFunction(
    () => window.__p.asPipelineData().stages[4].stale === true,
  );
  assert.equal(
    await p.evaluate(
      () => window.__p.G.getState().project.shots[0].video.approvedId,
    ),
    "approved",
  );
});
test("ComfyUI monitoring survives an outage without submitting the prompt twice", async (t) => {
  const p = await session(t);
  let prompts = 0,
    histories = 0;
  await p.route("https://recover.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/object_info")
      return route.fulfill({ json: { Test: { input: { required: {} } } } });
    if (path === "/prompt") {
      prompts++;
      return route.fulfill({ json: { prompt_id: "retained" } });
    }
    if (path === "/history/retained") {
      histories++;
      if (histories === 1) return route.abort("connectionrefused");
      return route.fulfill({
        json: {
          retained: {
            status: { completed: true, status_str: "success" },
            outputs: { one: { images: [{ filename: "image.png" }] } },
          },
        },
      });
    }
    if (path === "/view")
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    throw Error(path);
  });
  const result = await p.evaluate(async () => {
    const x = window.__p,
      p = structuredClone(x.G.getState().project);
    p.characters = [];
    p.environments = [];
    p.props = [];
    p.costumes = [];
    p.shots = p.shots.slice(0, 1);
    p.shots[0].imagePrompt = "A real keyframe prompt";
    p.shots[0].videoPrompt = "A real moving prompt";
    p.shots[0].image = { approvedId: null, versions: [] };
    x.G.getState().replace(p);
    x.K.getState().update({
      comfy: [{ id: "server", name: "Fixture", url: "https://recover.test" }],
      workflows: [
        {
          id: "image",
          name: "Image",
          json: '{"1":{"class_type":"Test","inputs":{}}}',
        },
      ],
      hardware: { giveUpSeconds: 5 },
    });
    await x.asProductionRun({
      ...x.asProduction().settings,
      serverId: "server",
      workflowImage: "image",
      stageFilter: "keyframes",
      attempts: 3,
    });
    return { batch: x.asProduction().batch, jobs: x.K.getState().jobs };
  });
  assert.equal(prompts, 1);
  assert.equal(histories, 2);
  assert.equal(result.batch.finished, true);
  assert.equal(result.jobs[0].remoteId, "retained");
});
test("context probe records a verified lower bound and diagnostics redacts credentials", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__p;
    x.K.getState().update({
      llm: [
        {
          id: "probe",
          kind: "simulation",
          model: "simulation",
          apiKey: "fixture-secret-value",
          contextWindow: 1024,
          maxOutputTokens: 128,
        },
      ],
      webApis: [
        {
          id: "secret",
          authHeader: "Authorization: Bearer another-secret-value",
        },
      ],
      simulation: { enabled: true, latencyMs: 0 },
    });
    return {
      probe: await x.asLLMContextProbe(x.K.getState().llm[0]),
      redacted: x.asRedact({
        message: "fixture-secret-value another-secret-value",
        authorization: "Bearer fixture-secret-value",
      }),
    };
  });
  assert.ok(result.probe.maximumVerifiedInputTokens > 0);
  assert.equal(result.probe.maximumCapacityProven, false);
  assert.ok(!result.redacted.includes("fixture-secret-value"));
  assert.ok(!result.redacted.includes("another-secret-value"));
});
test("ComfyUI audio attachment preserves schema v4 and orchestrator state", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(() => {
    const x = window.__p,
      p = structuredClone(x.G.getState().project);
    p.schemaVersion = 4;
    p.pipeline = {
      mode: "manual",
      stages: { 0: { status: "done", fingerprint: "saved" } },
    };
    p.shots[0].dialogue = [{ character: "MEERA", line: "నమస్తే", lang: "te" }];
    const next = x.asAttachGeneration(
      p,
      "audio",
      { shotId: p.shots[0].id, audioLine: 0 },
      "data:audio/wav;base64,AA==",
      "comfyui",
      "voice",
    );
    return x.Uc.parse(next);
  });
  assert.equal(result.schemaVersion, 4);
  assert.equal(result.pipeline.stages[0].fingerprint, "saved");
  assert.equal(result.production.audio[0].lang, "te");
});
