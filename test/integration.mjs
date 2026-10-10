import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const run = promisify(execFile);
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
const ticket = "A".repeat(43);
const player = {
  uuid: "00000000000040008000000000000001",
  name: "TestBuilder",
  role: "admin",
};

function string(value) {
  const text = Buffer.from(value);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(text.length);
  return Buffer.concat([length, text]);
}
function int(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}
function tag(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), string(name), payload]);
}
function compound(...tags) {
  return Buffer.concat([...tags, Buffer.from([0])]);
}
function vector(name, value) {
  return tag(
    10,
    name,
    compound(...["x", "y", "z"].map((axis) => tag(3, axis, int(value)))),
  );
}
function fixture() {
  const palette = Buffer.concat([
    Buffer.from([10]),
    int(2),
    compound(tag(8, "Name", string("minecraft:air"))),
    compound(tag(8, "Name", string("minecraft:stone"))),
  ]);
  const region = compound(
    vector("Size", 1),
    vector("Position", 0),
    tag(
      12,
      "BlockStates",
      Buffer.concat([int(1), Buffer.from([0, 0, 0, 0, 0, 0, 0, 1])]),
    ),
    tag(9, "BlockStatePalette", palette),
  );
  return gzipSync(
    tag(
      10,
      "",
      compound(
        tag(3, "Version", int(7)),
        tag(10, "Regions", compound(tag(10, "Main", region))),
      ),
    ),
  );
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function checked(response, expected) {
  assert.equal(
    response.status,
    expected,
    (await response.clone().text()).slice(0, 400),
  );
  return response;
}

test(
  "Worker exchanges a Sync ticket, publishes, lists, downloads, and deletes a schematic",
  { timeout: 90_000 },
  async (t) => {
    let redeemed = false;
    const sync = createServer(async (request, response) => {
      if (request.url !== "/library/redeem" || request.method !== "POST") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const valid =
        !redeemed &&
        JSON.parse(Buffer.concat(chunks).toString()).ticket === ticket;
      response.writeHead(valid ? 200 : 401, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(valid ? player : { error: "used" }));
      if (valid) redeemed = true;
    });
    await new Promise((done) => sync.listen(0, "127.0.0.1", done));
    t.after(() => new Promise((done) => sync.close(done)));

    const temp = resolve(".wrangler", `integration-${randomUUID()}`);
    await mkdir(temp, { recursive: true });
    const config = JSON.parse(await readFile("wrangler.json", "utf8"));
    config.main = resolve("src/index.ts");
    config.assets.directory = resolve("web");
    config.d1_databases[0].migrations_dir = resolve("migrations");
    config.vars = { SYNC_API_URL: `http://127.0.0.1:${sync.address().port}` };
    delete config.routes;
    const configPath = join(temp, "config.json");
    const state = join(temp, "state");
    await writeFile(configPath, JSON.stringify(config));
    await run(
      process.execPath,
      [
        wrangler,
        "d1",
        "migrations",
        "apply",
        "tongcraft-schematics",
        "--local",
        "--config",
        configPath,
        "--persist-to",
        state,
      ],
      { timeout: 30_000 },
    );

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const worker = (await import("node:child_process")).spawn(
      process.execPath,
      [
        wrangler,
        "dev",
        "--config",
        configPath,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--persist-to",
        state,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    worker.stdout.on("data", (chunk) => {
      logs = (logs + chunk).slice(-4000);
    });
    worker.stderr.on("data", (chunk) => {
      logs = (logs + chunk).slice(-4000);
    });
    t.after(() => {
      worker.kill("SIGINT");
    });

    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (worker.exitCode !== null) break;
      try {
        const health = await fetch(`${base}/api/health`);
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Worker is starting. */
      }
      await new Promise((done) => setTimeout(done, 200));
    }
    assert.ok(ready, `Worker did not start: ${logs}`);

    const origin = { Origin: base };
    await checked(
      await fetch(`${base}/api/items`, { method: "POST", headers: origin }),
      401,
    );
    const exchanged = await checked(
      await fetch(`${base}/api/session/exchange`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      }),
      200,
    );
    const cookie = exchanged.headers.get("set-cookie").split(";")[0];
    assert.deepEqual(
      (
        await (
          await fetch(`${base}/api/session`, { headers: { Cookie: cookie } })
        ).json()
      ).member,
      player,
    );

    const bytes = fixture();
    const preview = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
      "base64",
    );
    const form = new FormData();
    form.set("title", "测试建筑");
    form.set("description", "本地集成测试");
    form.set("tags", "建筑, 测试");
    form.set("file", new File([bytes], "sample.litematic"));
    form.set(
      "preview",
      new File([preview], "preview.png", { type: "image/png" }),
    );
    const invalid = new FormData();
    for (const [key, value] of form) invalid.set(key, value);
    invalid.set(
      "preview",
      new File(["<svg></svg>"], "preview.png", { type: "image/png" }),
    );
    await checked(
      await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { ...origin, Cookie: cookie },
        body: invalid,
      }),
      400,
    );
    const uploaded = await checked(
      await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { ...origin, Cookie: cookie },
        body: form,
      }),
      201,
    );
    const { id } = await uploaded.json();
    const afterUpload = await (
      await checked(
        await fetch(`${base}/api/usage`, { headers: { Cookie: cookie } }),
        200,
      )
    ).json();
    assert.equal(afterUpload.storageBytes, bytes.length + preview.length);
    assert.equal(afterUpload.puts, 2);

    const listed = await (
      await checked(
        await fetch(
          `${base}/api/items?q=%E6%B5%8B%E8%AF%95&tag=%E5%BB%BA%E7%AD%91&limit=4`,
        ),
        200,
      )
    ).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.items[0].id, id);
    assert.equal(listed.items[0].blocks, 1);
    assert.equal(listed.items[0].previewUrl, `/api/items/${id}/preview`);
    const image = await checked(
      await fetch(`${base}${listed.items[0].previewUrl}`),
      200,
    );
    assert.equal(image.headers.get("Content-Type"), "image/png");
    assert.match(image.headers.get("Cache-Control"), /public.*immutable/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), preview);
    await checked(await fetch(`${base}${listed.items[0].previewUrl}`), 200);
    const detail = await (
      await checked(await fetch(`${base}/api/items/${id}`), 200)
    ).json();
    assert.deepEqual(detail.item.materials, [
      { id: "minecraft:stone", count: 1 },
    ]);
    assert.equal(detail.item.previewUrl, listed.items[0].previewUrl);
    const download = await checked(
      await fetch(`${base}/api/items/${id}/file`),
      200,
    );
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.equal(
      download.headers.get("X-Content-SHA256"),
      createHash("sha256").update(bytes).digest("hex"),
    );
    const afterDownload = await (
      await checked(
        await fetch(`${base}/api/usage`, { headers: { Cookie: cookie } }),
        200,
      )
    ).json();
    assert.equal(
      afterDownload.gets,
      2,
      "Repeated previews must use the edge cache",
    );
    await checked(await fetch(`${base}/items/${id}`), 200);
    await checked(
      await fetch(`${base}/api/items/${id}`, {
        method: "DELETE",
        headers: { ...origin, Cookie: cookie },
      }),
      200,
    );
    await checked(await fetch(`${base}/api/items/${id}`), 404);
    await checked(await fetch(`${base}/api/items/${id}/preview`), 404);
    const afterDelete = await (
      await checked(
        await fetch(`${base}/api/usage`, { headers: { Cookie: cookie } }),
        200,
      )
    ).json();
    assert.equal(afterDelete.storageBytes, 0);
    // Older API clients can still upload a schematic without a preview.
    form.delete("preview");
    await checked(
      await fetch(`${base}/api/session/exchange`, {
        method: "POST",
        headers: { ...origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      }),
      401,
    );

    // Force thresholds in this isolated D1 database to verify fail-closed behavior.
    const sql = async (command) =>
      run(
        process.execPath,
        [
          wrangler,
          "d1",
          "execute",
          "tongcraft-schematics",
          "--local",
          "--config",
          configPath,
          "--persist-to",
          state,
          "--command",
          command,
        ],
        { timeout: 30_000 },
      );
    await sql("UPDATE storage_budget SET used_bytes=5000000000 WHERE id=1");
    await checked(
      await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { ...origin, Cookie: cookie },
        body: form,
      }),
      507,
    );
    await sql("UPDATE storage_budget SET used_bytes=0 WHERE id=1");
    // Failure on the image write must clean up the already-written schematic.
    await sql("UPDATE r2_daily_usage SET puts=499");
    form.set(
      "preview",
      new File([preview], "preview.png", { type: "image/png" }),
    );
    await checked(
      await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { ...origin, Cookie: cookie },
        body: form,
      }),
      429,
    );
    const rollbackUsage = await (
      await checked(
        await fetch(`${base}/api/usage`, {
          headers: { Cookie: cookie },
        }),
        200,
      )
    ).json();
    assert.equal(rollbackUsage.storageBytes, 0);
    assert.equal((await (await fetch(`${base}/api/items`)).json()).total, 0);
    form.delete("preview");
    await sql("UPDATE r2_daily_usage SET puts=0");
    const secondUpload = await checked(
      await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { ...origin, Cookie: cookie },
        body: form,
      }),
      201,
    );
    const secondId = (await secondUpload.json()).id;
    const legacy = await (
      await checked(await fetch(`${base}/api/items/${secondId}`), 200)
    ).json();
    assert.equal(legacy.item.previewUrl, undefined);
    await checked(await fetch(`${base}/api/items/${secondId}/preview`), 404);
    await sql("UPDATE r2_daily_usage SET gets=10000");
    await checked(await fetch(`${base}/api/items/${secondId}/file`), 429);
    await checked(
      await fetch(`${base}/api/items/${secondId}`, {
        method: "DELETE",
        headers: { ...origin, Cookie: cookie },
      }),
      200,
    );
  },
);
