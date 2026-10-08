import {
  createScene,
  readFile,
  SKIP_BLOCKS,
  TECHNICAL_BLOCKS,
  type AssetsInput,
  type CreateSceneOptions,
} from "block-model-renderer";
import * as THREE from "three";
import type { Schematic, Vec3 } from "./litematic";

/** Use the actual resource-pack blockstates and models, never substitute cubes. */
export async function buildSchematicScene(
  schematic: Schematic,
  assets: AssetsInput,
  options: CreateSceneOptions = {},
  allowEmpty = false,
) {
  const missing: string[] = [];
  const used = new Set<number>();
  for (let i = 0; i < schematic.raw.length; i += 4) used.add(schematic.raw[i]);
  for (const index of used) {
    const { id } = schematic.palette[index],
      [namespace, name] = id.split(":");
    if (
      namespace === "minecraft" &&
      (SKIP_BLOCKS.has(name) || TECHNICAL_BLOCKS.has(name))
    )
      continue;
    if (
      !(await readFile(`assets/${namespace}/blockstates/${name}.json`, assets))
    )
      missing.push(id);
  }
  if (missing.length)
    throw new Error(
      `资源包缺少方块模型：${missing.slice(0, 8).join("、")}。请选择对应的 Minecraft 资源包。`,
    );
  // Center around a small integer origin to avoid GPU precision loss when the
  // original selection is millions of blocks away from world origin.
  const origin = schematic.regions.reduce<Vec3>(
    (m, r) => m.map((n, a) => Math.min(n, r.min[a])) as Vec3,
    [Infinity, Infinity, Infinity],
  );
  const raw = new Int32Array(schematic.raw);
  for (let i = 0; i < raw.length; i += 4)
    for (let a = 0; a < 3; a++) raw[i + a + 1] -= origin[a];
  const handle = await createScene(
    assets,
    { palette: schematic.palette, raw, blockNbt: schematic.blockNbt },
    {
      defaults: "game",
      randomOffset: true,
      lighting: { light: false, brightness: 1 },
      optimize: true,
      release: false,
      origin,
      ...options,
    },
  );
  if (handle && handle.bounds.isEmpty() && !allowEmpty) {
    handle.dispose();
    throw new Error("投影中没有可见的方块模型");
  }
  return handle;
}

export function fitCamera(
  camera: THREE.OrthographicCamera,
  bounds: THREE.Box3,
  aspect: number,
  direction = new THREE.Vector3(-1, 0.65, -1),
) {
  const center = bounds.getCenter(new THREE.Vector3()),
    radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 16);
  camera.position
    .copy(center)
    .addScaledVector(direction.normalize(), radius * 3);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  const inverse = camera.matrixWorldInverse;
  let left = Infinity,
    right = -Infinity,
    bottom = Infinity,
    top = -Infinity;
  for (const x of [bounds.min.x, bounds.max.x])
    for (const y of [bounds.min.y, bounds.max.y])
      for (const z of [bounds.min.z, bounds.max.z]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(inverse);
        left = Math.min(left, p.x);
        right = Math.max(right, p.x);
        bottom = Math.min(bottom, p.y);
        top = Math.max(top, p.y);
      }
  const halfHeight =
    Math.max((top - bottom) / 2, (right - left) / 2 / aspect, 16) * 1.08;
  const cx = (left + right) / 2,
    cy = (bottom + top) / 2;
  camera.left = cx - halfHeight * aspect;
  camera.right = cx + halfHeight * aspect;
  camera.bottom = cy - halfHeight;
  camera.top = cy + halfHeight;
  camera.near = 0.1;
  camera.far = radius * 8;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  return center;
}
