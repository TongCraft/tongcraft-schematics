import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const run = promisify(execFile);
const base = "https://library.weiuou.top";
const directory = resolve("output/backfill-previews");
const manifestPath = join(directory, "manifest.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
// Use the same validator as the public upload endpoint without installing native renderers.
const { validatePreview, MAX_PREVIEW_BYTES } =
  await import("../output/backfill-previews/preview-validator.mjs").catch(
    async () => {
      await mkdir(directory, { recursive: true });
      const { build } = await import("esbuild");
      await build({
        entryPoints: ["src/preview.ts"],
        outfile: join(directory, "preview-validator.mjs"),
        format: "esm",
        platform: "node",
      });
      return import("../output/backfill-previews/preview-validator.mjs");
    },
  );

async function checked(response) {
  if (!response.ok)
    throw new Error(
      `${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return response;
}

async function sql(command) {
  const { stdout } = await run(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "d1",
      "execute",
      "tongcraft-schematics",
      "--remote",
      "--config",
      ".wrangler/deploy.json",
      "--command",
      command,
      "--json",
    ],
    { timeout: 60_000 },
  );
  const result = JSON.parse(stdout);
  if (!result.every((entry) => entry.success))
    throw new Error("D1 command failed");
  return result[0];
}

async function r2(action, id, path) {
  const args = [
    resolve("node_modules/wrangler/bin/wrangler.js"),
    "r2",
    "object",
    action,
    `tongcraft-schematics/previews/${id}.png`,
    "--remote",
    "--config",
    ".wrangler/deploy.json",
  ];
  if (action === "put")
    args.push("--file", path, "--content-type", "image/png");
  await run(process.execPath, args, { timeout: 60_000 });
}

if (process.argv[2] === "apply") {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const receipts = [];
  for (const entry of manifest.items) {
    if (!uuid.test(entry.id) || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new Error("Invalid manifest identity");
    const path = join(directory, `${entry.id}.png`);
    const bytes = await readFile(path);
    validatePreview(bytes);
    const row = (
      await sql(
        `SELECT hash,preview_size FROM items WHERE id='${entry.id}' AND deleted_at IS NULL`,
      )
    ).results[0];
    if (!row || row.hash !== entry.sha256)
      throw new Error(`素材已变化：${entry.title}`);
    if (row.preview_size > 0) {
      console.log(`跳过已有图片：${entry.title}`);
      continue;
    }
    const reservation = await sql(
      `UPDATE storage_budget SET used_bytes=used_bytes+${bytes.length} WHERE id=1 AND used_bytes+${bytes.length}<=5000000000`,
    );
    if (reservation.meta.changes !== 1)
      throw new Error("Storage budget exhausted");
    let attempted = false;
    try {
      const day = new Date().toISOString().slice(0, 10);
      const quota = await sql(
        `INSERT INTO r2_daily_usage(day,puts,gets) VALUES('${day}',1,0) ON CONFLICT(day) DO UPDATE SET puts=puts+1 WHERE puts+1<=500 AND gets<=10000`,
      );
      if (quota.meta.changes !== 1)
        throw new Error("R2 write budget exhausted");
      attempted = true;
      await r2("put", entry.id, path);
      const attached = await sql(
        `UPDATE items SET preview_size=${bytes.length} WHERE id='${entry.id}' AND hash='${entry.sha256}' AND preview_size=0 AND deleted_at IS NULL`,
      );
      if (attached.meta.changes !== 1) throw new Error("素材在补图时已变化");
    } catch (error) {
      // Release the reservation only after any possibly-written object is removed.
      if (attempted) await r2("delete", entry.id);
      await sql(
        `UPDATE storage_budget SET used_bytes=used_bytes-${bytes.length} WHERE id=1`,
      );
      throw error;
    }
    const image = await checked(
      await fetch(`${base}/api/items/${entry.id}/preview`),
    );
    if (hash(Buffer.from(await image.arrayBuffer())) !== hash(bytes))
      throw new Error("线上预览图校验失败");
    const detail = await (
      await checked(await fetch(`${base}/api/items/${entry.id}`))
    ).json();
    if (detail.item.sha256 !== entry.sha256 || !detail.item.previewUrl)
      throw new Error("线上目录校验失败");
    receipts.push({
      id: entry.id,
      title: entry.title,
      bytes: bytes.length,
      pngSha256: hash(bytes),
      schematicSha256: entry.sha256,
    });
    await writeFile(
      join(directory, "receipt.json"),
      JSON.stringify(
        { updatedAt: new Date().toISOString(), items: receipts },
        null,
        2,
      ),
    );
    console.log(`已保存并验证：${entry.title} · ${bytes.length} bytes`);
  }
  console.log(`补图完成：${receipts.length} 份`);
  process.exit();
}

await mkdir(directory, { recursive: true });
const catalogue = await (
  await checked(await fetch(`${base}/api/items?limit=24`))
).json();
if (catalogue.total > catalogue.items.length)
  throw new Error("Catalogue exceeds one page; use a paginated manifest");
const items = catalogue.items.filter((entry) => !entry.previewUrl);
for (const entry of items) {
  if (!uuid.test(entry.id)) throw new Error("Invalid catalogue id");
  const response = await checked(
    await fetch(`${base}/api/items/${entry.id}/file`),
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length !== entry.size ||
    bytes.length > 16 * 1024 * 1024 ||
    hash(bytes) !== entry.sha256
  )
    throw new Error("蓝图校验失败");
  await writeFile(join(directory, `${entry.id}.litematic`), bytes);
}
await writeFile(
  manifestPath,
  JSON.stringify(
    { source: base, generatedAt: new Date().toISOString(), items },
    null,
    2,
  ),
);
const state = { completed: [], current: "", progress: "", error: null };
const contentTypes = {
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  zip: "application/zip",
  wasm: "application/wasm",
};
let origin;
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, origin).pathname;
    if (request.method === "GET" && path === "/status") {
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(state));
    } else if (request.method === "GET" && path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><meta charset="utf-8"><title>TongCraft 旧素材补图</title><style>body{font:16px sans-serif;background:#f5f5f3;padding:24px}img{width:384px}article{display:inline-block;vertical-align:top;margin:12px}</style><h1>现有素材渲染图</h1><p id="status">开始生成…</p><main id="images"></main><script type="module">
        import { generatePreview } from '/assets/renderSchematic.js';
        const items = ${JSON.stringify(items).replaceAll("<", "\\u003c")};
        const label = document.querySelector('#status');
        const report = (body) => fetch('/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        try { for (const item of items) {
          label.textContent = '正在生成：' + item.title;
          await report({current:item.title,progress:'读取蓝图'});
          const bytes = new Uint8Array(await (await fetch('/schematics/'+item.id+'.litematic')).arrayBuffer());
          let previous = '';
          const blob = await generatePreview(bytes,text=>{label.textContent=item.title+' · '+text; if(text!==previous){previous=text;void report({progress:text});}});
          const saved = await fetch('/previews/'+item.id+'.png',{method:'POST',headers:{'Content-Type':'image/png'},body:blob});
          if(!saved.ok) throw new Error(await saved.text());
          const card=document.createElement('article'), image=document.createElement('img'), name=document.createElement('p');
          image.src=URL.createObjectURL(blob); image.alt=item.title; name.textContent=item.title; card.append(image,name);document.querySelector('#images').append(card);
        } label.textContent='全部生成完成'; await report({current:'',progress:'全部生成完成'}); }
        catch(error){label.textContent=error.message;await report({error:error.message});}
      </script>`);
    } else if (
      request.method === "GET" &&
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)
    ) {
      const asset = path.slice(8);
      response
        .writeHead(200, {
          "Content-Type":
            contentTypes[asset.split(".").at(-1)] ?? "application/octet-stream",
        })
        .end(await readFile(join(resolve("web/assets"), asset)));
    } else if (
      request.method === "GET" &&
      /^\/schematics\/[a-f0-9-]{36}\.litematic$/.test(path)
    ) {
      response
        .writeHead(200)
        .end(await readFile(join(directory, path.slice(12))));
    } else if (request.method === "POST" && request.headers.origin === origin) {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > MAX_PREVIEW_BYTES) throw new Error("Body too large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (path === "/status") {
        const input = JSON.parse(body);
        for (const key of ["current", "progress", "error"])
          if (Object.hasOwn(input, key))
            state[key] = String(input[key]).slice(0, 250);
        response.writeHead(200).end();
      } else {
        const match = path.match(/^\/previews\/([a-f0-9-]{36})\.png$/);
        if (!match || !items.some((entry) => entry.id === match[1]))
          throw new Error("Unknown preview");
        validatePreview(body);
        await writeFile(join(directory, `${match[1]}.png`), body);
        if (!state.completed.includes(match[1])) state.completed.push(match[1]);
        console.log(
          `生成完成：${items.find((entry) => entry.id === match[1]).title} · ${body.length} bytes`,
        );
        response.writeHead(200).end();
      }
    } else response.writeHead(404).end();
  } catch (error) {
    response.writeHead(400).end(error.message);
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;
console.log(`渲染页面：${origin}/`);
console.log(
  `待生成 ${items.length} 份；生成后运行 node scripts/backfill-previews.mjs apply`,
);
process.on("SIGINT", () => server.close(() => process.exit()));
