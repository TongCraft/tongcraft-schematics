import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync, zipSync } from "fflate";

const pin = JSON.parse(await readFile("config/minecraft-assets.json", "utf8"));
await mkdir(".wrangler/assets", { recursive: true });
await mkdir("web/assets", { recursive: true });
async function pinnedAsset(spec, extension) {
  const path = `.wrangler/assets/${spec.sha1}.${extension}`;
  let bytes = await readFile(path).catch(() => null);
  if (!bytes) {
    console.log(`Downloading pinned Minecraft ${pin.version} ${extension}…`);
    const response = await fetch(spec.url);
    if (!response.ok)
      throw new Error(`Minecraft resource download: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (
    bytes.length !== spec.size ||
    createHash("sha1").update(bytes).digest("hex") !== spec.sha1
  )
    throw new Error("Minecraft resource checksum mismatch");
  await writeFile(path, bytes);
  return bytes;
}
const [jar, languageBytes] = await Promise.all([
  pinnedAsset(pin.client, "jar"),
  pinnedAsset(pin.language, "json"),
]);
const language = JSON.parse(languageBytes.toString("utf8"));
const names = {};
for (const kind of ["block", "item"])
  for (const [key, value] of Object.entries(language)) {
    const match = key.match(new RegExp(`^${kind}\\.minecraft\\.([a-z0-9_]+)$`));
    if (match && typeof value === "string")
      names[`minecraft:${match[1]}`] ??= value;
  }
await writeFile(
  "web/assets/block-names.zh-CN.json",
  JSON.stringify({ version: pin.version, locale: pin.language.locale, names }),
);
const files = unzipSync(jar, {
  filter: (entry) =>
    /^assets\/minecraft\/(blockstates|models|textures|atlases)\//.test(
      entry.name,
    ),
});
await writeFile("web/assets/vanilla.zip", zipSync(files, { level: 6 }));
await writeFile(
  "web/assets/minecraft.json",
  JSON.stringify({ version: pin.version, sha1: pin.client.sha1 }),
);
await copyFile(
  "node_modules/block-model-renderer/assets.zip",
  "web/assets/renderer.zip",
);
await copyFile(
  "node_modules/block-model-renderer/wasm/block_model_renderer_bg.wasm",
  "web/assets/block_model_renderer_bg.wasm",
);
await build({
  entryPoints: ["client/renderSchematic.ts"],
  outfile: "web/assets/renderSchematic.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
});
console.log(
  `Built exact schematic renderer and ${Object.keys(files).length} Minecraft assets.`,
);
