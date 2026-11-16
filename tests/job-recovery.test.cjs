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
      "window.__jobs={G,K,Kl,asBeginGeneration,asSaveJobs,asResumeJob,asJobHealth,asJobControllers,Ul};</script>",
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
  await p.goto(base);
  await p.waitForFunction(
    () =>
      window.__jobs?.G.getState().hydrated &&
      window.__jobs.Kl.getState().activeId,
  );
  return p;
}
test("reload recovers prompt ID and resumes without resubmitting, durably attaching to originating shot", async (t) => {
  const p = await session(t),
    requests = [];
  await p.route("https://comfy.test/**", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url.includes("/history/"))
      return route.fulfill({
        json: {
          persisted: {
            status: { completed: true, status_str: "success" },
            outputs: { x: { images: [{ filename: "frame.png" }] } },
          },
        },
      });
    if (url.includes("/view?"))
      return route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    throw Error("Unexpected provider request " + url);
  });
  const id = await p.evaluate(async () => {
    const x = window.__jobs,
      shot = x.G.getState().project.shots[0],
      run = x.asBeginGeneration(
        {
          target: { shotId: shot.id },
          kind: "image",
          prompt: shot.imagePrompt,
          server: { id: "test", url: "https://comfy.test" },
          label: "Recovery fixture",
        },
        "comfyui",
      );
    x.K.getState().patchJob(run.id, { remoteId: "persisted" });
    await x.asSaveJobs();
    await x.Ul();
    run.finish();
    return run.id;
  });
  await p.reload();
  await p.waitForFunction(
    (id) => window.__jobs?.K.getState().jobs.some((j) => j.id === id),
    id,
  );
  await p.evaluate((id) => window.__jobs.asResumeJob(id), id);
  const job = await p.evaluate(
    (id) => window.__jobs.K.getState().jobs.find((j) => j.id === id),
    id,
  );
  assert.equal(job.status, "done");
  assert.equal(job.attached, true);
  await p.reload();
  await p.waitForFunction(() => window.__jobs?.G.getState().hydrated);
  assert.equal(
    await p.evaluate((id) => {
      const x = window.__jobs,
        j = x.K.getState().jobs.find((j) => j.id === id);
      return x.G.getState()
        .project.shots.find((s) => s.id === j.target.shotId)
        .image.versions.some((v) => v.id === j.result.versionId);
    }, id),
    true,
  );
  assert.ok(!requests.some((u) => u.endsWith("/prompt")));
});
test("health checks identify missing nodes and unavailable model choices", async (t) => {
  const p = await session(t);
  await p.route("https://comfy.test/object_info", (r) =>
    r.fulfill({
      json: {
        CheckpointLoaderSimple: {
          input: { required: { ckpt_name: [["installed.safetensors"]] } },
        },
      },
    }),
  );
  const problems = await p.evaluate(() =>
    window.__jobs.asJobHealth(
      { url: "https://comfy.test" },
      {
        json: JSON.stringify({
          1: {
            class_type: "CheckpointLoaderSimple",
            inputs: { ckpt_name: "missing.safetensors" },
          },
          2: { class_type: "MissingNode", inputs: {} },
        }),
      },
    ),
  );
  assert.equal(problems.length, 2);
  assert.ok(problems.some((s) => s.includes("MissingNode")));
  assert.ok(problems.some((s) => s.includes("missing.safetensors")));
});
