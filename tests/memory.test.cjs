const { test, before, after } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  http = require("node:http");
const { chromium } = require("playwright");
let server, browser, base;
before(async () => {
  const html = fs
    .readFileSync("index.html", "utf8")
    .replace(
      "</script>",
      "window.__mem={G,K,Kl,Wo,Go,Vl,Ul,asMediaWalk,asMediaPut,asMediaPack,asMediaRecords,asAnalysisLoadReview,asPipelineRuntime,asPipelineSave,asProductionSave,asLLMRequest,asLLMNotify,asLLMView,asSaveJobs};</script>",
    );
  server = http.createServer((q, r) => {
    r.setHeader("content-type", "text/html");
    r.end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--enable-precise-memory-info",
      "--js-flags=--max-old-space-size=256",
    ],
  });
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});
async function session(t) {
  const p = await browser.newPage();
  t.after(() => p.close());
  await p.goto(base + "#/");
  await p.waitForFunction(
    () =>
      window.__mem?.G.getState().hydrated &&
      window.__mem.Kl.getState().activeId,
  );
  return p;
}
test("media traversal bounds active work and preserves shared objects instead of cloning each history copy", async (t) => {
  const p = await session(t);
  const r = await p.evaluate(async () => {
    const x = window.__mem;
    let active = 0,
      peak = 0,
      count = 0;
    const shared = { url: "astra-media:shared" },
      value = {
        history: Array.from({ length: 1000 }, (_, i) => ({
          url: "astra-media:" + i,
        })),
        project: shared,
        snapshot: shared,
      };
    const result = await x.asMediaWalk(value, async (v) => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 0));
      count++;
      active--;
      return v;
    });
    return { peak, count, same: result.project === result.snapshot };
  });
  assert.equal(r.peak, 1);
  assert.equal(r.count, 1001);
  assert.equal(r.same, true);
});
test(
  "large project status checkpoints keep history stable under a 256 MB browser heap",
  { timeout: 120000 },
  async (t) => {
    const p = await session(t),
      cdp = await p.context().newCDPSession(p);
    await p.evaluate(async () => {
      const x = window.__mem,
        project = x.G.getState().project,
        shot = project.shots[0];
      x.G.setState({
        project: {
          ...project,
          schemaVersion: 4,
          pipeline: { mode: "manual", stages: {} },
          shots: Array.from({ length: 1500 }, (_, i) => ({
            ...shot,
            id: "stress" + i,
            imagePrompt: "x".repeat(2048) + i,
            videoPrompt: "v".repeat(1024) + i,
          })),
        },
        past: [],
        future: [],
        snapshots: [],
      });
      await x.asPipelineSave((d) => d);
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const before = await cdp.send("Runtime.getHeapUsage");
    const result = await p.evaluate(async () => {
      const x = window.__mem;
      for (let i = 0; i < 35; i++) {
        await x.asPipelineSave((d) => ({
          ...d,
          stages: { 0: { status: "running", counts: { succeeded: i } } },
        }));
        await x.asProductionSave((d) => ({
          ...d,
          batch: { done: i, total: 35 },
        }));
      }
      const saved = JSON.parse(await x.Wo("filmforge-project"));
      const history = x.G.getState().past.length;
      x.G.getState().updateShot("stress0", { action: "A manual edit" });
      return {
        history,
        manualHistory: x.G.getState().past.length,
        saved: saved.state.project.pipeline.stages[0].counts.succeeded,
        shots: saved.state.project.shots.length,
      };
    });
    await cdp.send("HeapProfiler.collectGarbage");
    const after = await cdp.send("Runtime.getHeapUsage");
    assert.equal(result.history, 0);
    assert.equal(result.manualHistory, 1);
    assert.equal(result.saved, 34);
    assert.equal(result.shots, 1500);
    assert.ok(
      after.usedSize - before.usedSize < 64 * 1024 * 1024,
      JSON.stringify({ before: before.usedSize, after: after.usedSize }),
    );
  },
);
test("review checkpoint is not loaded or hydrated when opening the app", async (t) => {
  const p = await session(t);
  await p.evaluate(async () => {
    const x = window.__mem,
      id = x.Kl.getState().activeId,
      media = await x.asMediaPut(
        new Blob([new Uint8Array(1024 * 1024)], { type: "video/webm" }),
      ),
      candidate = await x.asMediaPack({
        ...x.G.getState().project,
        reviewOnlyMedia: media,
      });
    await x.Go("astra-analysis-review:" + id, {
      candidate,
      errors: [],
      createdAt: Date.now(),
    });
  });
  await p.reload();
  await p.waitForFunction(
    () => window.__mem?.asPipelineRuntime.reviewAvailable,
  );
  assert.deepEqual(
    await p.evaluate(() => ({
      review: window.__mem.asPipelineRuntime.review,
      records: window.__mem.asMediaRecords.size,
    })),
    { review: null, records: 0 },
  );
  await p.evaluate(() => window.__mem.asAnalysisLoadReview());
  assert.equal(await p.evaluate(() => window.__mem.asMediaRecords.size), 0);
  assert.equal(
    await p.evaluate(() => window.__mem.asPipelineRuntime.review.errors.length),
    0,
  );
});
test("live LLM preview updates are batched and an oversized response aborts safely", async (t) => {
  const p = await session(t);
  const count = await p.evaluate(async () => {
    const x = window.__mem;
    let calls = 0;
    const fn = () => calls++;
    x.asLLMView.listeners.add(fn);
    for (let i = 0; i < 10000; i++) x.asLLMNotify();
    await new Promise((r) => setTimeout(r, 150));
    x.asLLMView.listeners.delete(fn);
    return calls;
  });
  assert.ok(count <= 2, "render notifications: " + count);
  await p.route("https://llm.test/**", (r) =>
    r.fulfill({
      json: {
        choices: [
          { message: { content: "x".repeat(40000) }, finish_reason: "stop" },
        ],
      },
    }),
  );
  await assert.rejects(
    p.evaluate(() =>
      window.__mem.asLLMRequest(
        {
          id: "limit",
          kind: "openai",
          baseUrl: "https://llm.test/v1",
          model: "test",
          maxOutputTokens: 1,
          streaming: false,
        },
        "s",
        "u",
      ),
    ),
    /memory limit/,
  );
});
test("a burst of job updates keeps only the latest queued journal payload and persists it", async (t) => {
  const p = await session(t);
  const r = await p.evaluate(async () => {
    const x = window.__mem,
      original = x.Vl.setItem;
    let writes = 0;
    x.Vl.setItem = async (key, payload) => {
      if (key === "astra-job-journal") {
        writes++;
        await new Promise((r) => setTimeout(r, 20));
      }
      return original(key, payload);
    };
    try {
      const pending = [];
      for (let i = 0; i < 150; i++) {
        x.K.getState().update({
          jobs: [{ id: "burst", status: "running", log: String(i) }],
        });
        pending.push(x.asSaveJobs());
      }
      await Promise.all(pending);
      return {
        writes,
        latest: JSON.parse(await x.Wo("astra-job-journal"))[0].log,
      };
    } finally {
      x.Vl.setItem = original;
    }
  });
  assert.equal(r.latest, "149");
  assert.ok(r.writes <= 4, "journal writes: " + r.writes);
});
test("snapshot media stays unloaded at startup and restores on demand", async (t) => {
  const p = await session(t);
  await p.evaluate(async () => {
    const x = window.__mem,
      bytes = Uint8Array.from(
        atob(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        ),
        (c) => c.charCodeAt(0),
      ),
      url = await x.asMediaPut(new Blob([bytes], { type: "image/png" })),
      snapshot = structuredClone(x.G.getState().project);
    snapshot.meta.title = "Restored snapshot";
    snapshot.shots[0].image = {
      approvedId: "snap",
      versions: [{ id: "snap", url, createdAt: 0, source: "upload" }],
    };
    x.G.setState({
      snapshots: [
        {
          id: "snap-test",
          label: "Saved media snapshot",
          createdAt: Date.now(),
          project: snapshot,
        },
      ],
    });
    await x.Ul();
  });
  await p.reload();
  await p.waitForFunction(() => window.__mem?.G.getState().hydrated);
  assert.equal(await p.evaluate(() => window.__mem.asMediaRecords.size), 0);
  assert.match(
    await p.evaluate(
      () =>
        window.__mem.G.getState().snapshots[0].project.shots[0].image
          .versions[0].url,
    ),
    /^astra-media:/,
  );
  await p.goto(base + "#/settings");
  await p.getByRole("button", { name: "restore", exact: true }).click();
  await p.waitForFunction(
    () => window.__mem.G.getState().project.meta.title === "Restored snapshot",
  );
  assert.match(
    await p.evaluate(
      () => window.__mem.G.getState().project.shots[0].image.versions[0].url,
    ),
    /^blob:/,
  );
});
