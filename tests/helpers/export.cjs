const fs = require("node:fs/promises");
const assert = require("node:assert/strict");
const path = require("node:path");
// Exercise the actual first-export dialog and unwrap the ZIP for existing content assertions.
exports.waitForExport = async function (page, timeout = 30000) {
  const event = page.waitForEvent("download", { timeout });
  const choose = page.getByRole("button", {
    name: "Download as ZIP instead",
    exact: true,
  });
  const timer = setInterval(
    () => choose.click({ timeout: 200 }).catch(() => {}),
    250,
  );
  try {
    const download = await event;
    if (!download.suggestedFilename().endsWith(".zip")) return download;
    const data = await fs.readFile(await download.path());
    assert.equal(data.readUInt32LE(data.length - 22), 0x06054b50);
    let at = data.readUInt32LE(data.length - 6);
    const files = [];
    while (data.readUInt32LE(at) === 0x02014b50) {
      const size = data.readUInt32LE(at + 24),
        nameLen = data.readUInt16LE(at + 28),
        extra = data.readUInt16LE(at + 30),
        comment = data.readUInt16LE(at + 32),
        offset = data.readUInt32LE(at + 42),
        name = data.subarray(at + 46, at + 46 + nameLen).toString();
      assert.equal(data.readUInt16LE(at + 10), 0, "store-only ZIP");
      const start =
        offset +
        30 +
        data.readUInt16LE(offset + 26) +
        data.readUInt16LE(offset + 28);
      files.push({ name, bytes: data.subarray(start, start + size) });
      at += 46 + nameLen + extra + comment;
    }
    const manifest = files.find((f) => f.name.endsWith("/manifest.json"));
    assert.ok(manifest);
    const payload = files.filter((f) => f !== manifest);
    assert.equal(payload.length, 1);
    const file = payload[0];
    assert.equal(
      JSON.parse(manifest.bytes).files.find((f) => f.path === file.name).bytes,
      file.bytes.length,
    );
    return {
      suggestedFilename: () => path.basename(file.name),
      saveAs: (dest) => fs.writeFile(dest, file.bytes),
      path: async () => {
        const dir = await fs.mkdtemp("/tmp/astra-export-test-"),
          dest = path.join(dir, path.basename(file.name));
        await fs.writeFile(dest, file.bytes);
        return dest;
      },
    };
  } finally {
    clearInterval(timer);
  }
};
