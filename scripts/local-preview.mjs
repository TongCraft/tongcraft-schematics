import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const run = promisify(execFile);
const filePath = process.argv[2];
if (!filePath) {
  console.error("用法: node scripts/local-preview.mjs <本地 .litematic 文件>");
  process.exit(1);
}

await run(process.execPath, ["scripts/build-renderer.mjs"]);

async function freePort() {
  const server = createTcpServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

const ticket = "A".repeat(43);
const sync = createServer((request, response) => {
  if (request.url !== "/library/redeem") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      uuid: "00000000000040008000000000000001",
      name: "本地预览",
      role: "admin",
    }),
  );
});
await new Promise((done) => sync.listen(0, "127.0.0.1", done));

const temp = resolve(".wrangler", `local-preview-${randomUUID()}`);
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
const wrangler = resolve("node_modules/wrangler/bin/wrangler.js");
await run(process.execPath, [
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
]);

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const worker = spawn(
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
for (const stream of [worker.stdout, worker.stderr])
  stream.on("data", (chunk) => {
    logs = (logs + chunk).slice(-4000);
  });

for (let attempt = 0; attempt < 100; attempt++) {
  if (worker.exitCode !== null)
    throw new Error(`本地 Worker 启动失败: ${logs}`);
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    // Wait for the local Worker.
  }
  await new Promise((done) => setTimeout(done, 200));
}

const exchange = await fetch(`${base}/api/session/exchange`, {
  method: "POST",
  headers: { Origin: base, "Content-Type": "application/json" },
  body: JSON.stringify({ ticket }),
});
if (!exchange.ok) throw new Error(await exchange.text());
const cookie = exchange.headers.get("set-cookie").split(";")[0];
const bytes = await readFile(filePath);
const form = new FormData();
form.set("title", basename(filePath).replace(/\.litematic$/i, ""));
form.set("description", "本地预览用投影，不会上传到线上素材库。");
form.set("tags", "建筑");
form.set("file", new File([bytes], basename(filePath)));
const upload = await fetch(`${base}/api/items`, {
  method: "POST",
  headers: { Origin: base, Cookie: cookie },
  body: form,
});
if (!upload.ok)
  throw new Error(`本地上传失败: ${await upload.text()}\n${logs}`);
const { id } = await upload.json();
console.log(`本地素材库: ${base}/`);
console.log(`投影详情: ${base}/items/${id}`);
console.log("按 Ctrl+C 结束本地预览。文件仅写入 .wrangler/ 下的本地测试数据。");

process.on("SIGINT", () => {
  worker.kill("SIGINT");
  sync.close();
  process.exit();
});
