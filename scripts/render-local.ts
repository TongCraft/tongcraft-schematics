import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import * as THREE from "three";
import {
  prepareAssets,
  makeModelScene,
  renderModelScene,
  disposeCache,
} from "block-model-renderer";
import {
  MAX_FILE_BYTES,
  MAX_NBT_BYTES,
  parseLitematic,
} from "../shared/litematic";
import { buildSchematicScene, fitCamera } from "../shared/render-scene";
import { selectLayer } from "../shared/layers";

const path = process.argv[2];
if (!path) throw new Error('用法: npm run render:local -- "文件.litematic"');
const bytes = await readFile(path);
if (bytes.length > MAX_FILE_BYTES) throw new Error("文件超过 16 MiB");
console.time("decode");
const schematic = parseLitematic(
  gunzipSync(bytes, { maxOutputLength: MAX_NBT_BYTES }),
);
console.timeEnd("decode");
const layer = process.argv[3] === undefined ? null : Number(process.argv[3]);
const selected = selectLayer(schematic, layer);
const prefix = layer === null ? "qiguan" : `qiguan-y${layer}`;
const metadata = JSON.parse(
  await readFile("web/assets/minecraft.json", "utf8"),
);
const assets = await prepareAssets("web/assets/vanilla.zip", {
  cache: true,
  version: metadata.version,
  defaults: "game",
});
let stageName = "";
console.time("build");
const handle = await buildSchematicScene(selected, assets, {
  animate: false,
  onProgress(stage, done, total) {
    const name = `${stage.name} ${Math.floor((done / Math.max(1, total)) * 10) * 10}%`;
    if (name !== stageName) {
      console.log(name);
      stageName = name;
    }
  },
});
console.timeEnd("build");
if (!handle) throw new Error("没有生成场景");
await mkdir("output/render", { recursive: true });
const { scene, camera } = makeModelScene();
scene.add(handle.group);
for (const [name, direction] of [
  ["isometric", [1, 0.75, 1]],
  ["opposite", [-1, 0.65, -1]],
  ["top", [0, 1, 0.001]],
] as const) {
  fitCamera(
    camera,
    handle.bounds,
    1600 / 1000,
    new THREE.Vector3(...direction),
  );
  await renderModelScene(scene, camera, {
    width: 1600,
    height: 1000,
    background: "#f5f5f3",
    path: `output/render/${prefix}-${name}.png`,
  });
}
const report = {
  sha256: createHash("sha256").update(bytes).digest("hex"),
  dataVersion: schematic.dataVersion,
  regions: schematic.regions,
  nonAirBlocks: schematic.solidBlocks,
  renderedInputBlocks: selected.raw.length / 4,
  maxLayer: layer,
  blockStates: schematic.palette.length,
  materials: schematic.materials,
  drawCalls: handle.drawCalls,
  triangles: handle.tris,
  bounds: {
    min: handle.bounds.min.toArray(),
    max: handle.bounds.max.toArray(),
  },
};
await writeFile(
  `output/render/${layer === null ? "report" : prefix}.json`,
  JSON.stringify(report, null, 2),
);
handle.dispose();
disposeCache(assets);
console.log(
  JSON.stringify({ ...report, materials: report.materials.length }, null, 2),
);
