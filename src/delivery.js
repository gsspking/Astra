/* ASTRA delivery extension. Embedded in index.html; no runtime dependencies. */
const asDeliveryDefaults = {
  folderTemplate: "{project}/{section}",
  fileTemplate: "S{scene}_SH{shot}_v{version}_{kind}",
  padding: 3,
  policy: "identical",
  layout: "latest",
  scope: "everything",
};
const asDelivery = {
  handle: null,
  settings: { ...asDeliveryDefaults },
  status: "Loading",
  loading: true,
  busy: false,
  progress: null,
  report: null,
  listeners: new Set(),
};
function asDeliveryNotify() {
  for (const fn of asDelivery.listeners) fn();
}
async function asDeliveryInit() {
  try {
    asDelivery.settings = {
      ...asDeliveryDefaults,
      ...(await Wo("astra-delivery-settings")),
    };
    asDelivery.handle = await Wo("astra-delivery-folder");
    await asDeliveryPermission();
  } catch (e) {
    asDelivery.status = e.message;
  } finally {
    asDelivery.loading = false;
    asDeliveryNotify();
  }
}
async function asDeliveryPermission() {
  asDelivery.status = !asDelivery.handle
    ? "Not set"
    : (await asDelivery.handle.queryPermission({ mode: "readwrite" })) ===
        "granted"
      ? "Ready"
      : "Needs permission";
  asDeliveryNotify();
  return asDelivery.status === "Ready";
}
async function asDeliveryChoose() {
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  await Go("astra-delivery-folder", handle);
  asDelivery.handle = handle;
  await asDeliveryPermission();
}
async function asDeliveryTest() {
  if (!(await asDeliveryPermission()))
    throw Error("Export folder needs permission");
  const name = ".astra-test-" + crypto.randomUUID();
  let created = false;
  try {
    const h = await asDelivery.handle.getFileHandle(name, { create: true });
    created = true;
    const w = await h.createWritable();
    try {
      await w.write("ASTRA write test");
      await w.close();
    } catch (e) {
      await w.abort().catch(() => {});
      throw e;
    }
  } finally {
    if (created) await asDelivery.handle.removeEntry(name);
  }
  return "Write and delete succeeded";
}
function asDeliverySlug(value, fallback = "item") {
  let s = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[. _-]+|[. _-]+$/g, "")
    .slice(0, 70);
  if (!s || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
    s =
      "id_" +
      String(fallback)
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 50);
  return s;
}
function asDeliveryPath(path) {
  return path
    .split("/")
    .filter(Boolean)
    .map((x) => asDeliverySlug(x))
    .join("/");
}
const asDeliveryEncoder = new TextEncoder();
// Incremental SHA-256 keeps working memory bounded while copying media streams.
class asDeliverySHA {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    this.buf = new Uint8Array(64);
    this.n = 0;
    this.bytes = 0;
  }
  block(block) {
    const k = asDeliverySHA.k,
      w = new Uint32Array(64),
      r = (v, n) => (v >>> n) | (v << (32 - n));
    for (let i = 0; i < 16; i++)
      w[i] =
        (block[i * 4] << 24) |
        (block[i * 4 + 1] << 16) |
        (block[i * 4 + 2] << 8) |
        block[i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      let a = w[i - 15],
        b = w[i - 2];
      w[i] =
        (w[i - 16] +
          (r(a, 7) ^ r(a, 18) ^ (a >>> 3)) +
          w[i - 7] +
          (r(b, 17) ^ r(b, 19) ^ (b >>> 10))) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      let t =
          (h +
            (r(e, 6) ^ r(e, 11) ^ r(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i] +
            w[i]) >>>
          0,
        u =
          ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>>
          0;
      h = g;
      g = f;
      f = e;
      e = (d + t) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t + u) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach(
      (v, i) => (this.h[i] = (this.h[i] + v) >>> 0),
    );
  }
  update(b) {
    this.bytes += b.length;
    for (let p = 0; p < b.length; ) {
      const n = Math.min(64 - this.n, b.length - p);
      this.buf.set(b.subarray(p, p + n), this.n);
      this.n += n;
      p += n;
      if (this.n === 64) {
        this.block(this.buf);
        this.n = 0;
      }
    }
    return this;
  }
  hex() {
    const size = this.bytes;
    this.update(new Uint8Array([128]));
    while (this.n !== 56) this.update(new Uint8Array([0]));
    const end = new Uint8Array(8),
      v = new DataView(end.buffer);
    v.setUint32(0, Math.floor(size / 0x20000000));
    v.setUint32(4, (size * 8) >>> 0);
    this.update(end);
    return [...this.h].map((x) => x.toString(16).padStart(8, "0")).join("");
  }
}
asDeliverySHA.k = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
async function* asDeliveryChunks(value) {
  if (value instanceof Blob) {
    const reader = value.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } else if (value?.[Symbol.asyncIterator]) {
    let buffer = new Uint8Array(65536),
      used = 0;
    for await (const chunk of value) {
      for (let offset = 0; offset < chunk.length; ) {
        const n = Math.min(buffer.length - used, chunk.length - offset);
        buffer.set(chunk.subarray(offset, offset + n), used);
        offset += n;
        used += n;
        if (used === buffer.length) {
          yield buffer;
          buffer = new Uint8Array(65536);
          used = 0;
        }
      }
    }
    if (used) yield buffer.subarray(0, used);
  } else yield asDeliveryEncoder.encode(String(value));
}
async function asDeliveryBlob(url) {
  const key = asMediaUrls.get(url) || url;
  if (key.startsWith("astra-media:")) {
    const b = await Wo(key);
    if (!(b instanceof Blob)) throw Error("Missing stored media: " + key);
    return b;
  }
  if (!/^(blob:|data:)/.test(url))
    throw Error("Remote media must be downloaded locally before delivery");
  const r = await fetch(url);
  if (!r.ok) throw Error("Media read failed: " + r.status);
  return r.blob();
}
// Serialize portable project JSON incrementally, including base64 in small chunks.
async function* asDeliveryJSON(value) {
  if (typeof value === "string" && /^(blob:|astra-media:)/.test(value)) {
    const b = await asDeliveryBlob(value);
    yield asDeliveryEncoder.encode('"data:' + b.type + ";base64,");
    for (let p = 0; p < b.size; p += 49152) {
      const bytes = new Uint8Array(await b.slice(p, p + 49152).arrayBuffer());
      let text = "";
      for (const n of bytes) text += String.fromCharCode(n);
      yield asDeliveryEncoder.encode(btoa(text));
    }
    yield asDeliveryEncoder.encode('"');
  } else if (Array.isArray(value)) {
    yield asDeliveryEncoder.encode("[");
    for (let i = 0; i < value.length; i++) {
      if (i) yield asDeliveryEncoder.encode(",");
      yield* asDeliveryJSON(value[i]);
    }
    yield asDeliveryEncoder.encode("]");
  } else if (value && typeof value === "object") {
    yield asDeliveryEncoder.encode("{");
    let first = true;
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (!first) yield asDeliveryEncoder.encode(",");
      first = false;
      yield asDeliveryEncoder.encode(JSON.stringify(key) + ":");
      yield* asDeliveryJSON(v);
    }
    yield asDeliveryEncoder.encode("}");
  } else yield asDeliveryEncoder.encode(JSON.stringify(value) ?? "null");
}
async function asDeliveryHash(value, signal) {
  const h = new asDeliverySHA();
  let bytes = 0;
  for await (const chunk of asDeliveryChunks(value)) {
    signal?.throwIfAborted();
    h.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: h.hex(), bytes };
}
async function asDeliveryFile(root, path, create = false) {
  const parts = path.split("/");
  let dir = root;
  for (const part of parts.slice(0, -1))
    dir = await dir.getDirectoryHandle(part, { create });
  return {
    dir,
    name: parts.at(-1),
    handle: await dir.getFileHandle(parts.at(-1), { create }),
  };
}
async function asDeliveryWrite(root, path, source, signal, onBytes = () => {}) {
  let exists = true;
  try {
    await asDeliveryFile(root, path);
  } catch (e) {
    if (e.name !== "NotFoundError") throw e;
    exists = false;
  }
  const { dir, name, handle } = await asDeliveryFile(root, path, true);
  let w;
  try {
    w = await handle.createWritable();
    for await (const chunk of asDeliveryChunks(source)) {
      signal?.throwIfAborted();
      await w.write(chunk);
      onBytes(chunk.length);
    }
    signal?.throwIfAborted();
    await w.close();
  } catch (e) {
    await w?.abort().catch(() => {});
    if (!exists) await dir.removeEntry(name).catch(() => {});
    throw e;
  }
}
function asDeliveryDownload(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
// Store-only ZIP/ZIP64, streamed to origin-private storage with 64-bit large-file records.
const asDeliveryCRC = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  return n >>> 0;
});
class asDeliveryZIP {
  constructor(write) {
    this.write = write;
    this.offset = 0;
    this.entries = [];
  }
  async put(bytes) {
    if (!Number.isSafeInteger(this.offset + bytes.length))
      throw Error("ZIP exceeds safe file offset");
    await this.write(bytes);
    this.offset += bytes.length;
  }
  async add(path, source, signal, sizeHint) {
    const name = asDeliveryEncoder.encode(path),
      offset = this.offset,
      known =
        sizeHint ??
        (source instanceof Blob
          ? source.size
          : typeof source === "string"
            ? asDeliveryEncoder.encode(source).length
            : null),
      large = known === null || known >= 0xffffffff,
      header = new Uint8Array(30 + name.length + (large ? 20 : 0)),
      v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, large ? 45 : 20, true);
    v.setUint16(6, 0x808, true);
    v.setUint16(12, 33, true);
    v.setUint16(26, name.length, true);
    header.set(name, 30);
    if (large) {
      v.setUint32(18, 0xffffffff, true);
      v.setUint32(22, 0xffffffff, true);
      v.setUint16(28, 20, true);
      const at = 30 + name.length;
      v.setUint16(at, 1, true);
      v.setUint16(at + 2, 16, true);
      v.setBigUint64(at + 4, BigInt(known || 0), true);
      v.setBigUint64(at + 12, BigInt(known || 0), true);
    }
    await this.put(header);
    let crc = 0xffffffff,
      size = 0;
    for await (const chunk of asDeliveryChunks(source)) {
      signal?.throwIfAborted();
      for (const b of chunk) crc = (crc >>> 8) ^ asDeliveryCRC[(crc ^ b) & 255];
      size += chunk.length;
      await this.put(chunk);
    }
    if (!large && size >= 0xffffffff)
      throw Error("Unexpected source size; retry with a known size");
    crc = (crc ^ 0xffffffff) >>> 0;
    const d = new Uint8Array(large ? 24 : 16),
      dv = new DataView(d.buffer);
    dv.setUint32(0, 0x08074b50, true);
    dv.setUint32(4, crc, true);
    if (large) {
      dv.setBigUint64(8, BigInt(size), true);
      dv.setBigUint64(16, BigInt(size), true);
    } else {
      dv.setUint32(8, size, true);
      dv.setUint32(12, size, true);
    }
    await this.put(d);
    this.entries.push({ name, offset, crc, size, large });
  }
  async close() {
    const start = this.offset;
    for (const e of this.entries) {
      const bigSize = e.large,
        bigOffset = e.offset >= 0xffffffff,
        extra = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0),
        b = new Uint8Array(46 + e.name.length + (extra ? extra + 4 : 0)),
        v = new DataView(b.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, 45, true);
      v.setUint16(6, extra ? 45 : 20, true);
      v.setUint16(8, 0x808, true);
      v.setUint16(14, 33, true);
      v.setUint32(16, e.crc, true);
      v.setUint32(20, bigSize ? 0xffffffff : e.size, true);
      v.setUint32(24, bigSize ? 0xffffffff : e.size, true);
      v.setUint16(28, e.name.length, true);
      v.setUint16(30, extra ? extra + 4 : 0, true);
      v.setUint32(42, bigOffset ? 0xffffffff : e.offset, true);
      b.set(e.name, 46);
      if (extra) {
        let at = 46 + e.name.length;
        v.setUint16(at, 1, true);
        v.setUint16(at + 2, extra, true);
        at += 4;
        if (bigSize) {
          v.setBigUint64(at, BigInt(e.size), true);
          v.setBigUint64(at + 8, BigInt(e.size), true);
          at += 16;
        }
        if (bigOffset) v.setBigUint64(at, BigInt(e.offset), true);
      }
      await this.put(b);
    }
    const centralSize = this.offset - start,
      zip64 =
        start >= 0xffffffff ||
        centralSize >= 0xffffffff ||
        this.entries.length >= 65535 ||
        this.entries.some((e) => e.large);
    if (zip64) {
      const zipEnd = this.offset,
        b = new Uint8Array(56),
        v = new DataView(b.buffer);
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setBigUint64(24, BigInt(this.entries.length), true);
      v.setBigUint64(32, BigInt(this.entries.length), true);
      v.setBigUint64(40, BigInt(centralSize), true);
      v.setBigUint64(48, BigInt(start), true);
      await this.put(b);
      const locator = new Uint8Array(20),
        lv = new DataView(locator.buffer);
      lv.setUint32(0, 0x07064b50, true);
      lv.setBigUint64(8, BigInt(zipEnd), true);
      lv.setUint32(16, 1, true);
      await this.put(locator);
    }
    const end = new Uint8Array(22),
      v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, Math.min(65535, this.entries.length), true);
    v.setUint16(10, Math.min(65535, this.entries.length), true);
    v.setUint32(12, Math.min(0xffffffff, centralSize), true);
    v.setUint32(16, Math.min(0xffffffff, start), true);
    await this.put(end);
  }
}
function asDeliveryDestination() {
  if (asDelivery.handle) return Promise.resolve("folder");
  return new Promise((resolve) => {
    const d = document.createElement("dialog");
    d.className = "astra-delivery-dialog";
    const title = document.createElement("h2");
    title.textContent = "Export & Delivery";
    d.append(title);
    const note = document.createElement("p");
    note.textContent = window.showDirectoryPicker
      ? "Choose an export folder or download a ZIP."
      : "Folder saving needs a Chromium-based browser. Download a ZIP instead.";
    d.append(note);
    const button = (label, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.onclick = fn;
      d.append(b);
    };
    const done = (v) => {
      d.close();
      d.remove();
      resolve(v);
    };
    if (window.showDirectoryPicker)
      button("Choose folder", async () => {
        try {
          await asDeliveryChoose();
          done("folder");
        } catch (e) {
          note.textContent = e.message;
        }
      });
    button("Download as ZIP instead", () => done("zip"));
    button("Cancel", () => done(null));
    d.oncancel = (e) => {
      e.preventDefault();
      done(null);
    };
    document.body.append(d);
    d.showModal();
  });
}
async function asDeliveryRun(
  entries,
  { project = G.getState().project, destination, scope = "single" } = {},
) {
  await asDelivery.ready;
  if (asDelivery.busy) throw Error("Another export is running");
  asDelivery.busy = true;
  asDelivery.report = null;
  asDeliveryNotify();
  const controller = new AbortController();
  asDelivery.cancel = () => controller.abort();
  const signal = controller.signal,
    settings = { ...asDelivery.settings },
    report = { written: 0, skipped: 0, failed: [], files: [] },
    start = Date.now();
  let temp,
    writer,
    zip,
    parts = [],
    buffered = 0;
  try {
    if (scope === "changed") settings.policy = "identical";
    destination = destination || (await asDeliveryDestination());
    if (!destination) return report;
    if (destination === "folder" && !(await asDeliveryPermission()))
      throw Error(
        "Export folder needs permission. Use Re-grant permission in Settings.",
      );
    const exportHandle = asDelivery.handle;
    const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .slice(0, 15)
        .replace("T", "-"),
      projectSlug = asDeliverySlug(project.meta.title, Kl.getState().activeId),
      freshRoot =
        projectSlug + (settings.layout === "timestamp" ? "_" + stamp : "");
    const rootKey = "astra-export-incomplete:" + projectSlug + ":" + scope;
    let rootName =
      destination === "folder" && settings.layout === "timestamp"
        ? (await Wo(rootKey)) || freshRoot
        : freshRoot;
    if (destination === "folder") await Go(rootKey, rootName);
    const manifest = {
      appVersion: "ASTRA-delivery-1",
      createdAt: new Date().toISOString(),
      projectTitle: project.meta.title,
      scope,
      settings,
      files: [],
    };
    const paths = new Set();

    if (destination === "folder") {
      try {
        const previous = JSON.parse(
          await (
            await (
              await asDeliveryFile(exportHandle, rootName + "/manifest.json")
            ).handle.getFile()
          ).text(),
        );
        if (previous.projectTitle === project.meta.title)
          manifest.files = previous.files || [];
      } catch (e) {
        if (e.name !== "NotFoundError" && !(e instanceof SyntaxError)) throw e;
      }
    }
    if (destination === "zip") {
      if (navigator.storage?.getDirectory) {
        const dir = await navigator.storage.getDirectory(),
          name = "astra-export-" + crypto.randomUUID() + ".zip";
        temp = {
          dir,
          name,
          handle: await dir.getFileHandle(name, { create: true }),
        };
        writer = await temp.handle.createWritable();
        zip = new asDeliveryZIP((bytes) => writer.write(bytes));
      } else
        zip = new asDeliveryZIP(async (bytes) => {
          buffered += bytes.length;
          if (buffered > 64 * 1024 * 1024)
            throw Error(
              "This browser cannot stream ZIP storage; exports are limited to 64 MiB. Use Chromium folder saving.",
            );
          parts.push(bytes);
        });
    }
    for await (const entry of entries) {
      signal.throwIfAborted();
      let relative = asDeliveryPath(entry.path),
        section = relative.split("/")[0];
      let base = settings.folderTemplate
        .replaceAll("{project}", rootName)
        .replaceAll("{section}", section);
      let path = asDeliveryPath(
        base + "/" + relative.split("/").slice(1).join("/"),
      );
      if (paths.has(path)) {
        const suffix = asDeliverySlug(entry.sourceId || String(paths.size));
        let index = 1,
          original = path;
        do {
          path = original.replace(
            /(\.[^/.]+)?$/,
            (_, ext) => "_" + suffix + "_" + index++ + (ext || ""),
          );
        } while (paths.has(path));
      }
      if (path.length > 240)
        throw Error(
          "Export path exceeds 240 characters; shorten the folder/file template: " +
            path,
        );
      paths.add(path);
      asDelivery.progress = {
        current: path,
        files: report.written + report.skipped,
        bytes: asDelivery.progress?.bytes || 0,
        elapsed: (Date.now() - start) / 1000,
        expectedFiles: Array.isArray(entries) ? entries.length : undefined,
      };
      asDeliveryNotify();
      try {
        const source = () => entry.open(),
          hash = await asDeliveryHash(await source(), signal);
        asDelivery.progress.currentBytes = hash.bytes;
        asDelivery.progress.etaSeconds =
          asDelivery.progress.bytes > 0
            ? hash.bytes /
              (asDelivery.progress.bytes /
                Math.max(0.001, (Date.now() - start) / 1000))
            : null;
        asDeliveryNotify();
        let skip = false;
        if (destination === "folder") {
          let old;
          try {
            old = await (
              await asDeliveryFile(exportHandle, path)
            ).handle.getFile();
          } catch (e) {
            if (e.name !== "NotFoundError") throw e;
          }
          if (
            old &&
            settings.policy === "identical" &&
            old.size === hash.bytes
          ) {
            skip = (await asDeliveryHash(old, signal)).sha256 === hash.sha256;
          }
          if (old && !skip && settings.policy === "both") {
            let i = 2;
            const original = path;
            for (;;) {
              path = original.replace(
                /(\.[^/.]+)?$/,
                (_, ext) => "_copy" + i + (ext || ""),
              );
              try {
                await asDeliveryFile(exportHandle, path);
                i++;
              } catch (e) {
                if (e.name !== "NotFoundError") throw e;
                break;
              }
            }
          }
          if (!skip)
            await asDeliveryWrite(
              exportHandle,
              path,
              await source(),
              signal,
              (n) => {
                asDelivery.progress.bytes += n;
                asDeliveryNotify();
              },
            );
        } else {
          await zip.add(path, await source(), signal, hash.bytes);
          asDelivery.progress.bytes += hash.bytes;
          asDeliveryNotify();
        }
        const record = {
          path,
          ...hash,
          sourceId: entry.sourceId || null,
          version: entry.version || null,
          approved: !!entry.approved,
          displayName: entry.displayName || entry.path,
        };
        manifest.files = manifest.files.filter((f) => f.path !== path);
        manifest.files.push(record);
        report.files.push(record);
        if (skip) report.skipped++;
        else report.written++;
      } catch (e) {
        if (signal.aborted) throw e;
        report.failed.push({ path, reason: e.message });
      }
    }
    signal.throwIfAborted();
    manifest.failures = report.failed;
    const manifestPath = rootName + "/manifest.json";
    if (zip) {
      await zip.add(manifestPath, JSON.stringify(manifest, null, 2), signal);
      await zip.close();
      if (writer) {
        await writer.close();
        writer = null;
        asDeliveryDownload(await temp.handle.getFile(), rootName + ".zip");
      } else
        asDeliveryDownload(
          new Blob(parts, { type: "application/zip" }),
          rootName + ".zip",
        );
    } else
      await asDeliveryWrite(
        exportHandle,
        manifestPath,
        JSON.stringify(manifest, null, 2),
        signal,
      );
    report.complete = report.failed.length === 0;
    if (destination === "folder")
      await Go("astra-last-export:" + projectSlug, {
        rootName,
        scope,
        complete: report.complete,
        at: Date.now(),
      });
    if (report.complete && destination === "folder") await Ko(rootKey);
    return report;
  } catch (e) {
    report.failed.push({
      path: asDelivery.progress?.current || "",
      reason: e.message,
    });
    report.cancelled = signal.aborted;
    throw e;
  } finally {
    await writer?.abort().catch(() => {});
    if (temp)
      setTimeout(() => temp.dir.removeEntry(temp.name).catch(() => {}), 65000);
    asDelivery.busy = false;
    asDelivery.progress = null;
    asDelivery.report = report;
    asDeliveryNotify();
  }
}
function asDeliverySection(name, type) {
  if (/pdf/.test(type) || /\.pdf$/i.test(name)) return "02_Storyboard";
  if (/webm|mp4/.test(type) || /\.(webm|mp4)$/i.test(name))
    return "06_Edit_Handoff";
  if (/\.csv$/i.test(name)) return "07_Reports";
  return "00_Project";
}
async function asDeliverySingle(name, content, type) {
  const section = asDeliverySection(name, type);
  return asDeliveryRun([
    {
      path: section + "/" + name,
      open: () => (typeof content === "function" ? content() : content),
    },
  ]);
}
function asDeliveryExt(blob) {
  return (
    {
      "video/mp4": "mp4",
      "video/webm": "webm",
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "audio/wav": "wav",
      "audio/mpeg": "mp3",
    }[blob.type.split(";")[0]] || "bin"
  );
}
async function* asDeliveryProject(project, scope = "everything") {
  if (["everything", "delivery"].includes(scope)) yield* asEditFiles(project);
  const text = (path, value, sourceId) => ({
    path,
    sourceId,
    open: () => (typeof value === "string" ? value : asDeliveryJSON(value)),
  });
  if (scope === "everything") {
    yield {
      path: "02_Storyboard/storyboard.pdf",
      open: () => asDeliveryPDF(project),
    };
    yield text("00_Project/project.astra.json", project);
    yield text(
      "00_Project/project_bible.md",
      "# " +
        project.meta.title +
        "\n\n" +
        Object.entries(project.meta)
          .filter(([k, v]) => typeof v !== "object")
          .map(([k, v]) => k + ": " + v)
          .join("\n\n"),
    );
    yield text("00_Project/script/script.fountain", project.script);
    yield text("00_Project/script/script.txt", project.script);
    for (const skill of project.skills)
      yield text(
        "00_Project/skills/" +
          asDeliverySlug(skill.name, skill.id) +
          "_" +
          asDeliverySlug(skill.id) +
          ".md",
        skill.body,
        skill.id,
      );
    for (const kind of ["characters", "environments", "props", "costumes"])
      for (const asset of project[kind]) {
        const base =
          "01_Breakup/" +
          kind +
          "/" +
          asDeliverySlug(asset.name, asset.id) +
          "_" +
          asDeliverySlug(asset.id);
        yield text(base + "/details.json", asset, asset.id);
        yield text(base + "/prompt.txt", asset.prompt, asset.id);
        const ref = asset.refs.find((r) => r.locked) || asset.refs[0];
        if (ref) {
          const b = await asDeliveryBlob(ref.url);
          yield {
            path: base + "/master." + asDeliveryExt(b),
            sourceId: asset.id,
            displayName: asset.name,
            open: () => asDeliveryBlob(ref.url),
          };
        }
        for (const angle of asset.angles || [])
          if (angle.image) {
            const b = await asDeliveryBlob(angle.image);
            yield {
              path:
                base +
                "/angles/" +
                asDeliverySlug(angle.name, angle.id) +
                "_" +
                asDeliverySlug(angle.id) +
                "." +
                asDeliveryExt(b),
              sourceId: asset.id,
              open: () => asDeliveryBlob(angle.image),
            };
          }
      }
  }
  for (const shot of asShots(project)) {
    const scene = project.scenes.find((s) => s.id === shot.sceneId),
      sceneCode = String(scene?.number || 1).padStart(3, "0"),
      code = "S" + sceneCode + "_SH" + String(shot.order).padStart(3, "0"),
      base =
        "03_Shots/Scene_" +
        sceneCode +
        "_" +
        asDeliverySlug(scene?.slug, scene?.id) +
        "/" +
        code;
    if (
      scope === "selected" &&
      !(asDelivery.settings.selectedScenes || []).includes(shot.sceneId)
    )
      continue;
    if (["everything", "selected", "changed"].includes(scope)) {
      yield text(base + "/shot.json", shot, shot.id);
      yield text(
        base + "/prompt.txt",
        (shot.imagePrompt || "") + "\n\n" + (shot.videoPrompt || ""),
        shot.id,
      );
      for (const kind of ["image", "video"])
        for (const [i, version] of shot[kind].versions.entries()) {
          const blob = await asDeliveryBlob(version.url),
            file = asDelivery.settings.fileTemplate
              .replaceAll("{scene}", sceneCode)
              .replaceAll(
                "{shot}",
                String(shot.order).padStart(asDelivery.settings.padding, "0"),
              )
              .replaceAll("{version}", String(i + 1).padStart(2, "0"))
              .replaceAll("{kind}", kind)
              .replaceAll(
                "{character}",
                asDeliverySlug(shot.dialogue[0]?.character, "cast"),
              )
              .replaceAll("{date}", new Date().toISOString().slice(0, 10));
          yield {
            path: base + "/" + asDeliverySlug(file) + "." + asDeliveryExt(blob),
            sourceId: shot.id,
            version: version.id,
            approved: shot[kind].approvedId === version.id,
            open: () => asDeliveryBlob(version.url),
          };
        }
    }
    if (scope === "everything") {
      const image = fl(shot.image);
      if (image) {
        const blob = await asDeliveryBlob(image.url);
        yield {
          path: "02_Storyboard/frames/" + code + "." + asDeliveryExt(blob),
          sourceId: shot.id,
          version: image.id,
          open: () => asDeliveryBlob(image.url),
        };
      }
    }
    for (const part of asApprovedParts(project, shot)) {
      const approved = part.version,
        blob = await asDeliveryBlob(approved.url);
      if (scope === "everything")
        yield {
          path:
            base +
            "/" +
            code +
            part.suffix +
            "_APPROVED_video." +
            asDeliveryExt(blob),
          sourceId: shot.id,
          version: approved.id,
          approved: true,
          open: () => asDeliveryBlob(approved.url),
        };
      yield {
        path:
          "04_Approved_Clips/Scene_" +
          sceneCode +
          "/" +
          code +
          part.suffix +
          "." +
          asDeliveryExt(blob),
        sourceId: shot.id,
        version: approved.id,
        approved: true,
        open: () => asDeliveryBlob(approved.url),
      };
    }
  }
}
function asDeliveryPanel() {
  const [, update] = j.useReducer((x) => x + 1, 0),
    [message, setMessage] = j.useState("");
  j.useEffect(() => {
    asDelivery.listeners.add(update);
    return () => asDelivery.listeners.delete(update);
  }, []);
  const act = (fn) => async () => {
      try {
        setMessage((await fn()) || "");
      } catch (e) {
        setMessage(e.message);
      }
    },
    field = (label, key, choices) =>
      asEl(
        "label",
        {},
        label,
        choices
          ? asEl(
              "select",
              {
                className: "field",
                value: asDelivery.settings[key],
                onChange: (e) => save(key, e.target.value),
              },
              ...choices.map(([value, label]) =>
                asEl("option", { key: value, value }, label),
              ),
            )
          : asEl("input", {
              className: "field",
              value: asDelivery.settings[key],
              onChange: (e) =>
                save(
                  key,
                  key === "padding"
                    ? Math.min(8, Math.max(1, Number(e.target.value)))
                    : e.target.value,
                ),
            }),
      );
  async function save(key, value) {
    try {
      const settings = { ...asDelivery.settings, [key]: value };
      await Go("astra-delivery-settings", settings);
      asDelivery.settings = settings;
      asDeliveryNotify();
    } catch (e) {
      setMessage(e.message);
    }
  }
  return asEl(
    "section",
    {
      className:
        "astra-delivery-panel grid gap-3 rounded-lg border border-border bg-card p-4",
    },
    asEl("h2", { className: "font-semibold" }, "Export & Delivery"),
    asEl(
      "p",
      {},
      (asDelivery.handle?.name || "Export folder") + " — " + asDelivery.status,
    ),
    !window.showDirectoryPicker &&
      asEl(
        "p",
        {},
        "Folder saving needs a Chromium-based browser. ZIP downloads are available.",
      ),
    asEl(
      "div",
      { className: "flex flex-wrap gap-2" },
      window.showDirectoryPicker &&
        asEl(
          Z,
          {
            disabled: asDelivery.loading || asDelivery.busy,
            onClick: act(asDeliveryChoose),
          },
          asDelivery.handle ? "Change folder" : "Choose export folder",
        ),
      asDelivery.handle &&
        asEl(
          Z,
          {
            onClick: act(async () => {
              await Ko("astra-delivery-folder");
              asDelivery.handle = null;
              await asDeliveryPermission();
            }),
          },
          "Clear",
        ),
      asDelivery.status === "Needs permission" &&
        asEl(
          Z,
          {
            onClick: act(async () => {
              await asDelivery.handle.requestPermission({ mode: "readwrite" });
              await asDeliveryPermission();
            }),
          },
          "Re-grant permission",
        ),
      asEl(Z, { onClick: act(asDeliveryTest) }, "Test write"),
    ),
    field("Folder structure template", "folderTemplate"),
    asEl(
      "small",
      {},
      "Preview: " +
        asDelivery.settings.folderTemplate
          .replaceAll("{project}", "My_Film")
          .replaceAll("{section}", "03_Shots") +
        "/Scene_001/S001_SH001",
    ),
    field("File naming template", "fileTemplate"),
    field("Zero padding", "padding"),
    field("Overwrite policy", "policy", [
      ["identical", "Skip identical"],
      ["overwrite", "Overwrite"],
      ["both", "Keep both"],
    ]),
    field("Export root layout", "layout", [
      ["latest", "Single rolling folder"],
      ["timestamp", "Timestamped folder per export"],
    ]),
    field("Default export scope", "scope", [
      ["everything", "Everything"],
      ["approved", "Approved clips only"],
      ["delivery", "Delivery Pack only"],
      ["selected", "Selected scenes"],
      ["changed", "Changed since last export"],
    ]),
    asDelivery.settings.scope === "selected" &&
      asEl(
        "label",
        {},
        "Scenes",
        asEl(
          "select",
          {
            className: "field",
            multiple: true,
            value: asDelivery.settings.selectedScenes || [],
            onChange: (e) =>
              save(
                "selectedScenes",
                [...e.target.selectedOptions].map((o) => o.value),
              ),
          },
          ...G.getState().project.scenes.map((scene) =>
            asEl(
              "option",
              { key: scene.id, value: scene.id },
              asSceneLabel(scene) + " " + scene.slug,
            ),
          ),
        ),
      ),
    asEl(
      Z,
      {
        disabled: asDelivery.busy,
        onClick: act(() =>
          asDeliveryRun(
            asDeliveryProject(G.getState().project, asDelivery.settings.scope),
            { scope: asDelivery.settings.scope },
          ).then(() => "Export finished — see report"),
        ),
      },
      "Export project folder",
    ),
    asDelivery.busy &&
      asEl(
        "div",
        { role: "status" },
        asEl("progress", {}),
        asEl(
          "p",
          {},
          `${asDelivery.progress?.files || 0} files • ${((asDelivery.progress?.bytes || 0) / 1048576).toFixed(1)} MiB • ${(asDelivery.progress?.current || "Preparing") + (asDelivery.progress?.etaSeconds ? " • estimated current file " + Math.ceil(asDelivery.progress.etaSeconds) + "s" : "")}`,
        ),
        asEl(Z, { onClick: () => asDelivery.cancel() }, "Cancel export"),
      ),
    asDelivery.report &&
      asEl(
        "details",
        {},
        asEl(
          "summary",
          {},
          `${asDelivery.report.written} written, ${asDelivery.report.skipped} skipped, ${asDelivery.report.failed.length} failed — folder tree`,
        ),
        asEl(
          "pre",
          {
            style: { maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap" },
          },
          asDelivery.report.files.map((f) => f.path).join("\n") +
            "\n" +
            asDelivery.report.failed
              .map((f) => f.path + ": " + f.reason)
              .join("\n"),
        ),
      ),
    asEl("p", { role: "status" }, message),
  );
}

function asDeliveryStatus() {
  const [, refresh] = j.useReducer((x) => x + 1, 0),
    [hidden, setHidden] = j.useState(false);
  j.useEffect(() => {
    const fn = () => {
      setHidden(false);
      refresh();
    };
    asDelivery.listeners.add(fn);
    return () => asDelivery.listeners.delete(fn);
  }, []);
  if (hidden || (!asDelivery.busy && !asDelivery.report)) return null;
  return asEl(
    "aside",
    { className: "astra-delivery-status", role: "status" },
    asDelivery.busy
      ? asEl(
          j.Fragment,
          {},
          asEl("strong", {}, "Exporting"),
          asEl("progress", {}),
          asEl("p", {}, asDelivery.progress?.current || "Choose a destination"),
          asEl(
            "p",
            {},
            `${asDelivery.progress?.files || 0} files • ${((asDelivery.progress?.bytes || 0) / 1048576).toFixed(1)} MiB`,
          ),
          asEl(Z, { onClick: () => asDelivery.cancel() }, "Cancel export"),
        )
      : asEl(
          j.Fragment,
          {},
          asEl(
            "strong",
            {},
            `${asDelivery.report.written} written, ${asDelivery.report.skipped} skipped, ${asDelivery.report.failed.length} failed`,
          ),
          asEl(
            "details",
            {},
            asEl("summary", {}, "Folder tree and errors"),
            asEl(
              "pre",
              {},
              asDelivery.report.files.map((f) => f.path).join("\n") +
                "\n" +
                asDelivery.report.failed.map((f) => f.reason).join("\n"),
            ),
          ),
          asEl(Z, { onClick: () => setHidden(true) }, "Dismiss"),
        ),
  );
}
// Offline raster storyboard PDF; each page is released before the next is rendered.
async function* asDeliveryPDF(project) {
  let options = {
    size: "A4",
    landscape: true,
    cols: 3,
    rows: 2,
    margin: 12,
    gap: 6,
    cover: true,
    newPagePerScene: true,
    scope: "all",
    caption: "below",
    fields: ["description", "type", "lens", "duration", "dialogue"],
    header: "{title} — {scene}",
    footer: "Page {page} / {pages}",
    watermark: "",
    grayscale: false,
  };
  try {
    options = {
      ...options,
      ...JSON.parse(localStorage.getItem("ff-pdf-last") || "{}"),
    };
  } catch {}
  const cols = Math.max(1, Math.min(8, Number(options.cols) || 3)),
    rows = Math.max(1, Math.min(10, Number(options.rows) || 2)),
    perPage = cols * rows,
    sheets = [];
  for (const scene of [...project.scenes].sort((a, b) => a.number - b.number)) {
    if (options.scope !== "all" && options.scope !== scene.id) continue;
    const shots = project.shots
      .filter((s) => s.sceneId === scene.id)
      .sort((a, b) => a.order - b.order);
    for (const shot of shots) {
      if (
        !sheets.length ||
        sheets.at(-1).shots.length === perPage ||
        (options.newPagePerScene && sheets.at(-1).scene !== scene)
      )
        sheets.push({ scene, shots: [] });
      sheets.at(-1).shots.push(shot);
    }
  }
  if (options.cover) sheets.unshift({ cover: true, shots: [] });
  if (!sheets.length) sheets.push({ shots: [] });
  const pages = sheets.length,
    offsets = [0],
    dims = {
      A4: [210, 297],
      A3: [297, 420],
      Letter: [215.9, 279.4],
      Legal: [215.9, 355.6],
    }[options.size] || [210, 297],
    mmW = options.landscape ? Math.max(...dims) : Math.min(...dims),
    mmH = options.landscape ? Math.min(...dims) : Math.max(...dims),
    pdfW = (mmW * 72) / 25.4,
    pdfH = (mmH * 72) / 25.4,
    pixelW = Math.round(mmW * 5),
    pixelH = Math.round(mmH * 5);
  let offset = 0;
  function bytes(s) {
    const b = asDeliveryEncoder.encode(s);
    offset += b.length;
    return b;
  }
  function object(id, s) {
    offsets[id] = offset;
    return bytes(id + " 0 obj\n" + s + "\nendobj\n");
  }
  yield bytes("%PDF-1.4\n");
  yield object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  yield object(
    2,
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => 3 + i * 3 + " 0 R").join(" ")}] >>`,
  );
  for (let page = 0; page < pages; page++) {
    const canvas = document.createElement("canvas");
    canvas.width = pixelW;
    canvas.height = pixelH;
    const c = canvas.getContext("2d"),
      sheet = sheets[page],
      margin = Math.max(5, Number(options.margin) || 12) * 5,
      gap = Math.max(0, Number(options.gap) || 0) * 5,
      cellW = (pixelW - margin * 2 - gap * (cols - 1)) / cols,
      cellH = (pixelH - margin * 2 - 90 - gap * (rows - 1)) / rows;
    c.fillStyle = "white";
    c.fillRect(0, 0, pixelW, pixelH);
    c.fillStyle = "black";
    c.font = "24px sans-serif";
    const substitute = (text) =>
      String(text || "")
        .replaceAll("{title}", project.meta.title)
        .replaceAll("{scene}", sheet.scene?.slug || "")
        .replaceAll("{page}", String(page + 1))
        .replaceAll("{pages}", String(pages))
        .replaceAll("{date}", new Date().toLocaleDateString())
        .replaceAll("{director}", project.meta.directingStyle || "");
    c.fillText(substitute(options.header), margin, margin, pixelW - margin * 2);
    c.font = "18px sans-serif";
    c.fillText(
      substitute(options.footer),
      margin,
      pixelH - margin / 2,
      pixelW - margin * 2,
    );
    if (sheet.cover) {
      c.font = "48px sans-serif";
      c.fillText(project.meta.title, margin, pixelH / 2, pixelW - margin * 2);
      c.font = "24px sans-serif";
      c.fillText(
        project.meta.logline || "",
        margin,
        pixelH / 2 + 60,
        pixelW - margin * 2,
      );
    }
    for (const [i, shot] of sheet.shots.entries()) {
      const x = margin + (i % cols) * (cellW + gap),
        y = margin + 45 + Math.floor(i / cols) * (cellH + gap),
        frameW = options.caption === "right" ? cellW * 0.62 : cellW,
        frameH = Math.min(
          cellH * (options.caption === "hidden" ? 0.88 : 0.64),
          frameW / al(project.meta.aspectRatio),
        );
      c.fillStyle = "black";
      c.font = "20px sans-serif";
      c.fillText(asLabel(project, shot), x, y, cellW);
      const version = fl(shot.image);
      if (version?.url) {
        const blob = await asDeliveryBlob(version.url),
          bitmap = await createImageBitmap(blob);
        try {
          const scale = Math.min(frameW / bitmap.width, frameH / bitmap.height);
          c.save();
          if (options.grayscale) c.filter = "grayscale(1)";
          c.drawImage(
            bitmap,
            x + (frameW - bitmap.width * scale) / 2,
            y + 14,
            bitmap.width * scale,
            bitmap.height * scale,
          );
          c.restore();
        } finally {
          bitmap.close();
        }
      }
      if (options.caption !== "hidden") {
        const text = (options.fields || [])
            .map((field) =>
              field === "description"
                ? shot.action
                : field === "dialogue"
                  ? shot.dialogue
                      .map((l) => l.character + ": " + l.line)
                      .join(" ")
                  : field === "characters"
                    ? shot.characterIds
                        .map(
                          (id) =>
                            project.characters.find((c) => c.id === id)?.name ||
                            id,
                        )
                        .join(", ")
                    : String(shot[field] || ""),
            )
            .join(" • "),
          textX = options.caption === "right" ? x + frameW + 8 : x,
          textY = options.caption === "right" ? y + 22 : y + frameH + 38,
          textW = options.caption === "right" ? cellW - frameW - 8 : cellW,
          maxRows = Math.max(1, Math.floor((cellH - (textY - y)) / 23));
        c.font = "18px sans-serif";
        let line = "",
          row = 0;
        for (const word of text.split(/\s+/)) {
          if (c.measureText(line + " " + word).width > textW) {
            c.fillText(line, textX, textY + row * 23, textW);
            line = word;
            if (++row >= maxRows) break;
          } else line += " " + word;
        }
        if (row < maxRows) c.fillText(line, textX, textY + row * 23, textW);
      }
    }
    if (options.watermark) {
      c.save();
      c.globalAlpha = 0.15;
      c.font = "60px sans-serif";
      c.translate(pixelW / 2, pixelH / 2);
      c.rotate(-0.4);
      c.fillText(options.watermark, -pixelW * 0.4, 0, pixelW * 0.8);
      c.restore();
    }
    const jpeg = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.88));
    canvas.width = canvas.height = 0;
    const id = 3 + page * 3;
    yield object(
      id,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfW} ${pdfH}] /Resources << /XObject << /Im ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`,
    );
    offsets[id + 1] = offset;
    yield bytes(
      `${id + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pixelW} /Height ${pixelH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.size} >>\nstream\n`,
    );
    for await (const chunk of asDeliveryChunks(jpeg)) {
      offset += chunk.length;
      yield chunk;
    }
    yield bytes("\nendstream\nendobj\n");
    const command = `q ${pdfW} 0 0 ${pdfH} 0 0 cm /Im Do Q`;
    yield object(
      id + 2,
      `<< /Length ${command.length} >>\nstream\n${command}\nendstream`,
    );
  }
  const xref = offset;
  yield bytes(
    `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((v) => String(v).padStart(10, "0") + " 00000 n \n")
        .join("") +
      `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
