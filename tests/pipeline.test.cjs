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
      "window.__pipeline={G,K,Kl,Uc,asProduction,asProductionSave,asProductionPlan,asProductionRun,asBatch,asEditFiles,asClipSegments,asProductionApprove,asMediaPut,asProductionQC,asAudioUpload,asAudioLine,asApprovedParts,asEditTimeline,asRevisionDiff,asDelivery};</script>",
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
  await browser.close();
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
      window.__pipeline?.G.getState().hydrated &&
      window.__pipeline.Kl.getState().activeId,
  );
  return p;
}
test("pipeline page exposes all phases and preserves schema v3 metadata", async (t) => {
  const p = await session(t);
  for (const name of [
    "Plan",
    "Review",
    "Audio",
    "QC & Post",
    "Animatic & Revisions",
    "Final checklist",
  ]) {
    await p.getByRole("button", { name, exact: true }).click();
  }
  assert.ok(
    await p
      .getByRole("heading", { name: "Final checklist", exact: true })
      .count(),
  );
  assert.equal(
    await p.evaluate(() => {
      const x = window.__pipeline,
        project = x.Uc.parse({
          ...x.G.getState().project,
          schemaVersion: 3,
          production: {
            settings: { takes: 3 },
            audio: [{ id: "audio", url: "data:audio/wav;base64,AA==" }],
          },
        });
      return project.production.settings.takes;
    }),
    3,
  );
});
test("handoff has exact approved filenames, timeline gaps and Unicode subtitles", async (t) => {
  const p = await session(t);
  const files = await p.evaluate(async () => {
    const x = window.__pipeline,
      p = structuredClone(x.G.getState().project);
    p.shots = p.shots.slice(0, 2);
    p.shots[0].video = {
      approvedId: "v",
      versions: [
        {
          id: "v",
          url: await x.asMediaPut(
            new Blob(["original"], { type: "video/mp4" }),
          ),
        },
      ],
    };
    p.shots[0].dialogue = [{ character: "తెలుగు", line: "నమస్తే", lang: "te" }];
    p.shots[1].video = { approvedId: null, versions: [] };
    const files = {};
    for await (const entry of x.asEditFiles(p))
      files[entry.path] = await entry.open();
    return files;
  });
  fs.mkdirSync("test-results/handoff", { recursive: true });
  for (const [path, content] of Object.entries(files))
    if (typeof content === "string")
      fs.writeFileSync(
        "test-results/handoff/" + path.split("/").at(-1),
        content,
      );
  assert.match(files["06_Edit_Handoff/project.edl"], /R0000001/);
  assert.match(files["06_Edit_Handoff/project.fcpxml"], /<gap/);
  assert.match(
    files["06_Edit_Handoff/project.fcpxml"],
    /\.\.\/04_Approved_Clips\//,
  );
  assert.match(files["06_Edit_Handoff/subtitles_te.srt"], /నమస్తే/);
  const otio = JSON.parse(files["06_Edit_Handoff/project.otio"]);
  assert.equal(otio.tracks.children[0].children[1].OTIO_SCHEMA, "Gap.1");
  assert.match(files["07_Reports/missing_assets.csv"], /No approved video/);
});
test("take approval keeps originals and records rejected alternatives", async (t) => {
  const p = await session(t);
  const r = await p.evaluate(async () => {
    const x = window.__pipeline,
      p = x.G.getState().project,
      s = p.shots[0];
    x.G.getState().updateShot(s.id, {
      video: {
        approvedId: null,
        versions: [
          { id: "one", url: "x" },
          { id: "two", url: "y" },
        ],
      },
    });
    await x.asProductionApprove(s.id, "two");
    return {
      shot: x.G.getState().project.shots[0],
      data: x.asProduction().shots[s.id],
    };
  });
  assert.equal(r.shot.video.versions.length, 2);
  assert.equal(r.shot.video.approvedId, "two");
  assert.deepEqual(r.data.rejected, ["one"]);
});
test("clip planner splits model-limited shots and estimator counts each segment/take", async (t) => {
  const p = await session(t);
  const r = await p.evaluate(() => {
    const x = window.__pipeline,
      p = structuredClone(x.G.getState().project);
    p.characters = [];
    p.environments = [];
    p.props = [];
    p.costumes = [];
    p.shots = p.shots.slice(0, 1);
    p.shots[0].duration = 13;
    p.shots[0].video = { approvedId: null, versions: [] };
    p.shots[0].image = { approvedId: "i", versions: [{ id: "i", url: "x" }] };
    p.modelProfiles = [
      { id: "m", parameters: { maxClipLength: 5, pricePerGeneration: 0.1 } },
    ];
    return x.asProductionPlan(p, {
      ...x.asProduction(p).settings,
      modelProfileId: "m",
      takes: 2,
    });
  });
  assert.equal(r.jobs, 6);
  assert.ok(Math.abs(r.spend - 0.6) < 1e-8);
  assert.deepEqual(
    r.tasks.slice(0, 3).map((t) => t.segment.duration),
    [5, 5, 3],
  );
});
test(
  "20-scene batch retries a provider failure, saves takes, QC and timings without losing review state",
  { timeout: 120000 },
  async (t) => {
    const p = await session(t);
    const { execFileSync } = require("node:child_process");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=160x90:r=12:d=0.5",
      "-c:v",
      "libvpx",
      "/tmp/astra-batch.webm",
    ]);
    const video = fs.readFileSync("/tmp/astra-batch.webm"),
      seeds = [];
    let prompts = 0;
    await p.route("https://comfy.test/**", async (route) => {
      const q = route.request(),
        url = q.url();
      if (url.endsWith("/object_info"))
        return route.fulfill({
          json: { TestNode: { input: { required: {} } } },
        });
      if (url.includes("/upload/image"))
        return route.fulfill({ json: { name: "ref.png" } });
      if (url.endsWith("/prompt")) {
        prompts++;
        seeds.push(JSON.parse(q.postData()).prompt["1"].inputs.seed);
        if (prompts === 1)
          return route.fulfill({
            status: 503,
            body: "temporary provider failure",
          });
        return route.fulfill({ json: { prompt_id: "job-" + prompts } });
      }
      if (url.includes("/history/")) {
        const id = url.split("/").at(-1);
        return route.fulfill({
          json: {
            [id]: {
              status: { completed: true, status_str: "success" },
              outputs: { one: { videos: [{ filename: "clip.webm" }] } },
            },
          },
        });
      }
      if (url.includes("/view?"))
        return route.fulfill({ body: video, contentType: "video/webm" });
      throw Error(url);
    });
    const result = await p.evaluate(async () => {
      const x = window.__pipeline,
        old = x.G.getState().project,
        s = old.shots[0],
        url = await x.asMediaPut(
          new Blob(["reference"], { type: "image/png" }),
        ),
        scenes = Array.from({ length: 20 }, (_, i) => ({
          ...old.scenes[0],
          id: "s" + i,
          number: i + 1,
        })),
        shots = scenes.map((scene, i) => ({
          ...s,
          id: "shot" + i,
          sceneId: scene.id,
          duration: 0.5,
          order: 1,
          dialogue: [],
          image: { approvedId: "im", versions: [{ id: "im", url }] },
          video: { approvedId: null, versions: [] },
        }));
      x.G.getState().replace({
        ...old,
        characters: [],
        environments: [],
        costumes: [],
        props: [],
        scenes,
        shots,
      });
      x.K.getState().update({
        comfy: [{ id: "server", url: "https://comfy.test", name: "Fixture" }],
        workflows: [
          {
            id: "video",
            name: "Fixture",
            json: '{"1":{"class_type":"TestNode","inputs":{"seed":"{{seed}}"}}}',
          },
        ],
      });
      await x.asDelivery.ready;
      const root = await navigator.storage.getDirectory();
      x.asDelivery.handle = {
        queryPermission: async () => "granted",
        getDirectoryHandle: (...a) => root.getDirectoryHandle(...a),
        getFileHandle: (...a) => root.getFileHandle(...a),
        removeEntry: (...a) => root.removeEntry(...a),
      };
      await x.asProductionRun({
        ...x.asProduction().settings,
        takes: 1,
        autoDelivery: true,
        attempts: 2,
        serverId: "server",
        workflowVideo: "video",
      });
      const state = x.asProduction();
      return {
        batch: state.batch,
        takes: x.G.getState().project.shots.map((s) => s.video.versions.length),
        qc: Object.values(state.shots).filter(
          (s) => Object.keys(s.qc || {}).length,
        ).length,
        timings: state.timings,
        delivery: x.asDelivery.report,
      };
    });
    assert.equal(prompts, 21);
    assert.notEqual(seeds[0], seeds[1]);
    assert.equal(result.batch.finished, true);
    assert.deepEqual(result.batch.failures, []);
    assert.ok(result.takes.every((n) => n === 1));
    assert.equal(result.qc, 20);
    assert.equal(result.timings["default:video"].count, 20);
    assert.equal(result.delivery.complete, true);
    assert.ok(
      result.delivery.files.some((f) => f.path.endsWith("project.otio")),
    );
  },
);
test("audio upload survives portable JSON and schema v3 import with Telugu language metadata", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__pipeline,
      s = x.G.getState().project.shots[0];
    x.G.getState().updateShot(s.id, {
      dialogue: [{ character: "మీరా", line: "నమస్తే", lang: "te" }],
    });
    const shot = x.G.getState().project.shots[0];
    await x.asAudioUpload(
      new File([new Uint8Array([82, 73, 70, 70])], "line.wav", {
        type: "audio/wav",
      }),
      shot,
      0,
    );
    return x.Uc.parse(x.G.getState().project).production.audio[0];
  });
  assert.equal(result.lang, "te");
  assert.equal(result.character, "మీరా");
  assert.match(result.url, /^blob:/);
  assert.match(result.name, /S\d+_SH\d+_L01_/);
});
test("approved segmented takes relink every part in order without transcoding", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__pipeline,
      p = structuredClone(x.G.getState().project),
      shot = p.shots[0];
    p.shots = [shot];
    shot.duration = 5;
    shot.video = {
      approvedId: "v2",
      versions: [
        {
          id: "v1",
          url: await x.asMediaPut(new Blob(["one"], { type: "video/mp4" })),
        },
        {
          id: "v2",
          url: await x.asMediaPut(new Blob(["two"], { type: "video/mp4" })),
        },
      ],
    };
    p.production = {
      shots: {
        [shot.id]: {
          segments: [
            { index: 0, start: 0, duration: 3, take: 1, versionId: "v1" },
            { index: 1, start: 3, duration: 2, take: 1, versionId: "v2" },
          ],
        },
      },
    };
    const timeline = await x.asEditTimeline(p);
    return {
      parts: x
        .asApprovedParts(p, shot)
        .map((s) => ({ duration: s.duration, suffix: s.suffix })),
      paths: timeline.clips.map((c) => c.path),
      frames: timeline.frames,
    };
  });
  assert.deepEqual(result.parts, [
    { duration: 3, suffix: "_part01" },
    { duration: 2, suffix: "_part02" },
  ]);
  assert.match(result.paths[0], /_part01.mp4$/);
  assert.match(result.paths[1], /_part02.mp4$/);
  assert.ok(result.frames > 0);
});
test("unavailable configured provider blocks the batch before generation", async (t) => {
  const p = await session(t);
  await assert.rejects(
    p.evaluate(() =>
      window.__pipeline.asProductionRun({
        ...window.__pipeline.asProduction().settings,
        serverId: "missing",
        workflowVideo: "missing",
      }),
    ),
    /Choose|ComfyUI/,
  );
  assert.equal(await p.evaluate(() => window.__pipeline.asBatch.active), false);
});
test("dialogue web adapter receives Telugu text and saves returned audio", async (t) => {
  const p = await session(t);
  let body;
  await p.route("https://tts.test/**", async (route) => {
    body = JSON.parse(route.request().postData());
    await route.fulfill({
      contentType: "audio/wav",
      body: Buffer.from("RIFF fixture audio"),
    });
  });
  const result = await p.evaluate(async () => {
    const x = window.__pipeline,
      s = x.G.getState().project.shots[0];
    x.G.getState().updateShot(s.id, {
      dialogue: [{ character: "మీరా", line: "నమస్తే", lang: "te" }],
    });
    x.K.getState().update({
      webApis: [
        {
          id: "tts",
          endpoint: "https://tts.test/speak",
          authHeader: "",
          template: '{"text":"{{text}}","language":"{{language}}"}',
          responsePath: "url",
        },
      ],
    });
    await x.asProductionSave((d) => ({
      ...d,
      settings: { ...d.settings, ttsApiId: "tts" },
    }));
    await x.asAudioLine(s.id, 0);
    return x.asProduction().audio[0];
  });
  assert.equal(body.text, "నమస్తే");
  assert.equal(body.language, "te");
  assert.equal(result.lang, "te");
});
