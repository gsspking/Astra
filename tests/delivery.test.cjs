const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { chromium } = require("playwright");
let browser, server, base;
before(async () => {
  const html = fs
    .readFileSync("index.html", "utf8")
    .replace(
      "</script>",
      "window.__delivery={asDelivery,asDeliverySHA,asDeliveryHash,asDeliveryRun,asDeliveryProject,asDeliveryJSON,asDeliverySlug,asDeliveryWrite,asDeliveryZIP,G,Kl,asMediaPut};</script>",
    );
  server = http.createServer((q, r) => {
    r.setHeader("Content-Type", "text/html");
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
      window.__delivery?.G.getState().hydrated &&
      !window.__delivery.asDelivery.loading,
  );
  return p;
}
test("incremental hashes match WebCrypto across block boundaries and multiple chunks", async (t) => {
  const p = await session(t);
  assert.equal(
    await p.evaluate(async () => {
      const { asDeliverySHA } = window.__delivery;
      for (const size of [0, 1, 55, 56, 63, 64, 65, 10000, 1000000]) {
        const b = new Uint8Array(size);
        for (let i = 0; i < size; i++) b[i] = i % 251;
        const h = new asDeliverySHA();
        for (let i = 0; i < size; i += 37) h.update(b.subarray(i, i + 37));
        const expected = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", b)),
        ]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("");
        if (h.hex() !== expected) return false;
      }
      return true;
    }),
    true,
  );
});
test("folder writes preserve bytes, skip unchanged content and write manifest last", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__delivery;
    const root = await navigator.storage.getDirectory();
    x.asDelivery.handle = {
      queryPermission: async () => "granted",
      getDirectoryHandle: (...a) => root.getDirectoryHandle(...a),
      getFileHandle: (...a) => root.getFileHandle(...a),
    };
    x.asDelivery.settings.layout = "latest";
    const blob = new Blob(["తెలుగు original video"], { type: "video/mp4" }),
      entries = [
        {
          path: "04_Approved_Clips/test.mp4",
          sourceId: "shot1",
          approved: true,
          open: () => blob,
        },
      ];
    const project = { meta: { title: "Test" } };
    const first = await x.asDeliveryRun(entries, {
      project,
      destination: "folder",
    });
    const second = await x.asDeliveryRun(entries, {
      project,
      destination: "folder",
    });
    const dir = await root.getDirectoryHandle("Test"),
      manifest = JSON.parse(
        await (
          await (await dir.getFileHandle("manifest.json")).getFile()
        ).text(),
      ),
      clips = await dir.getDirectoryHandle("04_Approved_Clips"),
      actual = await (await clips.getFileHandle("test.mp4")).getFile();
    return {
      first: first.written,
      skip: second.skipped,
      text: await actual.text(),
      manifest,
    };
  });
  assert.equal(result.first, 1);
  assert.equal(result.skip, 1);
  assert.equal(result.text, "తెలుగు original video");
  assert.equal(result.manifest.files[0].approved, true);
  assert.match(result.manifest.files[0].sha256, /^[a-f0-9]{64}$/);
});
test("portable JSON streams Unicode and local media into an importable JSON document", async (t) => {
  const p = await session(t);
  const result = await p.evaluate(async () => {
    const x = window.__delivery;
    const url = await x.asMediaPut(
      new Blob([new Uint8Array(100001).fill(129)], { type: "image/png" }),
    );
    const chunks = [];
    for await (const b of x.asDeliveryJSON({ name: "తెలుగు", url }))
      chunks.push(b);
    return JSON.parse(await new Blob(chunks).text());
  });
  assert.equal(result.name, "తెలుగు");
  assert.equal(Buffer.from(result.url.split(",")[1], "base64").length, 100001);
});
test("cancel aborts atomic writes and removes newly created partial files", async (t) => {
  const p = await session(t);
  assert.deepEqual(
    await p.evaluate(async () => {
      const x = window.__delivery,
        dir = await navigator.storage.getDirectory(),
        c = new AbortController();
      let error;
      async function* content() {
        yield new Uint8Array([1, 2, 3]);
        c.abort();
        yield new Uint8Array([4]);
      }
      try {
        await x.asDeliveryWrite(dir, "cancel/new.bin", content(), c.signal);
      } catch (e) {
        error = e.name;
      }
      let absent = false;
      try {
        await (await dir.getDirectoryHandle("cancel")).getFileHandle("new.bin");
      } catch (e) {
        absent = e.name === "NotFoundError";
      }
      return { error, absent };
    }),
    { error: "AbortError", absent: true },
  );
});
test("ZIP fallback contains UTF-8 content and valid store-only directory entries", async (t) => {
  const p = await session(t);
  const download = p.waitForEvent("download");
  await p.evaluate(async () => {
    const x = window.__delivery;
    await x.asDeliveryRun(
      [{ path: "00_Project/script.txt", open: () => "తెలుగు" }],
      { project: { meta: { title: "ZIP Test" } }, destination: "zip" },
    );
  });
  const file = await download,
    path = await file.path(),
    b = fs.readFileSync(path);
  assert.equal(b.readUInt32LE(0), 0x04034b50);
  assert.equal(b.readUInt32LE(b.length - 22), 0x06054b50);
  assert.equal(b.readUInt16LE(b.length - 12), 2);
  assert.ok(b.includes(Buffer.from("తెలుగు")));
  assert.ok(b.includes(Buffer.from("manifest.json")));
});
test(
  "one thousand approved clips export sequentially and a second run skips all unchanged bytes",
  { timeout: 120000 },
  async (t) => {
    const p = await session(t);
    const result = await p.evaluate(async () => {
      const x = window.__delivery,
        root = await navigator.storage.getDirectory();
      x.asDelivery.handle = {
        queryPermission: async () => "granted",
        getDirectoryHandle: (...a) => root.getDirectoryHandle(...a),
        getFileHandle: (...a) => root.getFileHandle(...a),
      };
      const media = await x.asMediaPut(
        new Blob([new Uint8Array(4096).fill(91)], { type: "video/mp4" }),
      );
      const project = {
        ...x.G.getState().project,
        meta: { ...x.G.getState().project.meta, title: "Thousand" },
        scenes: [{ id: "s", number: 1, slug: "Scene" }],
        shots: Array.from({ length: 1000 }, (_, i) => ({
          id: "shot-" + i,
          sceneId: "s",
          order: i + 1,
          duration: 3,
          dialogue: [],
          video: { approvedId: "v", versions: [{ id: "v", url: media }] },
        })),
      };
      const before = performance.memory?.usedJSHeapSize || 0;
      const first = await x.asDeliveryRun(
        x.asDeliveryProject(project, "approved"),
        { project, destination: "folder" },
      );
      const second = await x.asDeliveryRun(
        x.asDeliveryProject(project, "approved"),
        { project, destination: "folder" },
      );
      return {
        written: first.written,
        skipped: second.skipped,
        failures: [...first.failed, ...second.failed],
        heapGrowth: (performance.memory?.usedJSHeapSize || 0) - before,
      };
    });
    assert.equal(result.written, 1000);
    assert.equal(result.skipped, 1000);
    assert.deepEqual(result.failures, []);
    assert.ok(result.heapGrowth < 128 * 1024 * 1024, JSON.stringify(result));
  },
);
test("folder single-project export is nonempty after its hash pass and preserves Telugu", async (t) => {
  const p = await session(t);
  await p.evaluate(async () => {
    const x = window.__delivery,
      root = await navigator.storage.getDirectory();
    x.asDelivery.handle = {
      queryPermission: async () => "granted",
      getDirectoryHandle: (...a) => root.getDirectoryHandle(...a),
      getFileHandle: (...a) => root.getFileHandle(...a),
    };
    x.asDelivery.settings.layout = "latest";
  });
  await p.goto(base + "#/io");
  await p
    .getByRole("button", {
      name: "Download project (.ffproj.json)",
      exact: true,
    })
    .click();
  await p.waitForFunction(() => window.__delivery.asDelivery.report?.complete);
  const data = await p.evaluate(async () => {
    const x = window.__delivery,
      record = x.asDelivery.report.files[0];
    let root = await navigator.storage.getDirectory();
    const parts = record.path.split("/");
    for (const part of parts.slice(0, -1))
      root = await root.getDirectoryHandle(part);
    const text = await (
      await (await root.getFileHandle(parts.at(-1))).getFile()
    ).text();
    return {
      actual: JSON.parse(text),
      expected: JSON.parse(JSON.stringify(x.G.getState().project)),
    };
  });
  assert.deepEqual(data.actual, data.expected);
});
test("Settings persists the export handle across reload and verifies write/delete access", async (t) => {
  const p = await session(t);
  await p.addInitScript(() => {
    window.showDirectoryPicker = () => navigator.storage.getDirectory();
  });
  await p.reload();
  await p.goto(base + "#/settings");
  await p
    .getByRole("button", { name: "Choose export folder", exact: true })
    .click();
  await p.getByRole("button", { name: "Test write", exact: true }).click();
  await p.getByText("Write and delete succeeded", { exact: true }).waitFor();
  await p.reload();
  await p.waitForFunction(
    () => window.__delivery.asDelivery.status === "Ready",
  );
  assert.equal(
    await p.getByRole("button", { name: "Change folder", exact: true }).count(),
    1,
  );
  await p.getByRole("button", { name: "Clear", exact: true }).click();
  await p.waitForFunction(
    () => window.__delivery.asDelivery.status === "Not set",
  );
});
test("ZIP64 stream records are readable by a standard ZIP reader", async (t) => {
  const p = await session(t);
  const bytes = await p.evaluate(async () => {
    const { asDeliveryZIP } = window.__delivery,
      chunks = [],
      zip = new asDeliveryZIP(async (b) => chunks.push(b));
    async function* source() {
      yield new TextEncoder().encode("తెలుగు ZIP64");
    }
    await zip.add("unicode.txt", source());
    await zip.close();
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  const dir = require("node:os").tmpdir(),
    file = require("node:path").join(dir, "astra-zip64-" + Date.now() + ".zip");
  fs.writeFileSync(file, Buffer.from(bytes));
  const { execFileSync } = require("node:child_process");
  assert.equal(
    execFileSync(
      "python3",
      [
        "-c",
        'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read("unicode.txt").decode(),end="")',
        file,
      ],
      { encoding: "utf8" },
    ),
    "తెలుగు ZIP64",
  );
  fs.unlinkSync(file);
});
