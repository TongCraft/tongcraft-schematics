import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as THREE from "three";
import {
  prepareAssets,
  disposeCache,
  type AssetsInput,
} from "block-model-renderer";
import type { Schematic } from "../shared/litematic";
import { selectLayer } from "../shared/layers";
import { buildSchematicScene } from "../shared/render-scene";
import { buildLayeredScene } from "../shared/render-layers";

let assets: AssetsInput;
before(async () => {
  const { version } = JSON.parse(
    await readFile("web/assets/minecraft.json", "utf8"),
  );
  assets = await prepareAssets("web/assets/vanilla.zip", {
    cache: true,
    version,
    defaults: "game",
  });
});
after(() => disposeCache(assets));

function pillar(
  id: string,
  properties: Record<string, string> = {},
): Schematic {
  return {
    volume: 33,
    version: 7,
    dataVersion: 4671,
    solidBlocks: 33,
    materials: [],
    regions: [
      {
        name: "pillar",
        min: [20, -16, 30],
        max: [20, 16, 30],
        position: [20, -16, 30],
        size: [1, 33, 1],
      },
    ],
    palette: [{ id, properties }],
    raw: Int32Array.from(
      Array.from({ length: 33 }, (_, i) => [0, 20, i - 16, 30]).flat(),
    ),
    blockNbt: new Map(),
  };
}

/** Compare actual visible surfaces, independently of how faces are merged. */
function surfaces(group: THREE.Group) {
  group.updateMatrixWorld(true);
  const planes = new Map<string, number>();
  const bounds = new THREE.Box3();
  let area = 0,
    topArea = 0;
  group.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const positions = mesh.geometry.getAttribute("position"),
      index = mesh.geometry.index;
    const instances = (mesh as THREE.InstancedMesh).isInstancedMesh
      ? (mesh as THREE.InstancedMesh).count
      : 1;
    for (let instance = 0; instance < instances; instance++) {
      const transform = mesh.matrixWorld.clone();
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        const matrix = new THREE.Matrix4();
        (mesh as THREE.InstancedMesh).getMatrixAt(instance, matrix);
        transform.multiply(matrix);
      }
      for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
        const points = [0, 1, 2].map((offset) =>
          new THREE.Vector3()
            .fromBufferAttribute(
              positions,
              index ? index.getX(i + offset) : i + offset,
            )
            .applyMatrix4(transform),
        );
        const triangle = new THREE.Triangle(
          ...(points as [THREE.Vector3, THREE.Vector3, THREE.Vector3]),
        );
        const value = triangle.getArea();
        if (value < 1e-8) continue;
        const normal = triangle.getNormal(new THREE.Vector3());
        const key = [...normal.toArray(), normal.dot(points[0])]
          .map((n) => Math.round(n * 1e5))
          .join(":");
        planes.set(key, (planes.get(key) ?? 0) + value);
        area += value;
        if (normal.y > 0.999) topArea += value;
        points.forEach((point) => bounds.expandByPoint(point));
      }
    }
  });
  return { planes, bounds, area, topArea };
}

function assertSameSurfaces(actual: THREE.Group, expected: THREE.Group) {
  const a = surfaces(actual),
    b = surfaces(expected);
  assert.deepEqual([...a.planes.keys()].sort(), [...b.planes.keys()].sort());
  for (const [plane, area] of b.planes) {
    assert.ok(
      Math.abs(a.planes.get(plane)! - area) < Math.max(0.01, area * 1e-5),
      `surface area at ${plane}`,
    );
  }
}

test("chunk seams and cutoffs expose exactly one top face without leftover higher geometry", async () => {
  const schematic = pillar("minecraft:stone");
  const layered = await buildLayeredScene(schematic, assets, {
    animate: false,
  });
  try {
    assert.equal(layered.stats.bodyBuilds, 3);
    for (const y of [-16, -8, -1, 0, 7, 15, 16, null]) {
      const selected = await layered.prepareLayer(y);
      assert.ok(selected);
      layered.show(selected);
      const geometry = surfaces(layered.group),
        height = (y ?? 16) + 17;
      assert.equal(geometry.area, (4 * height + 2) * 256);
      assert.equal(geometry.topArea, 256);
      assert.equal(geometry.bounds.max.y, (height - 1) * 16 + 8);
      assert.equal(geometry.bounds.min.y, -8);
      assert.equal(layered.stats.bodyBuilds, 3);
      assert.equal(layered.visibleBlocks, height);
    }
    const empty = await layered.prepareLayer(-17);
    assert.ok(empty);
    layered.show(empty);
    assert.equal(surfaces(layered.group).area, 0);
  } finally {
    await layered.dispose();
  }
});

test("glass, fluids and stairs keep the same boundary surfaces as a complete filtered build", async () => {
  for (const schematic of [
    pillar("minecraft:glass"),
    pillar("minecraft:water", { level: "0" }),
    pillar("minecraft:oak_stairs", {
      facing: "east",
      half: "top",
      shape: "inner_left",
      waterlogged: "false",
    }),
  ]) {
    const layered = await buildLayeredScene(schematic, assets, {
      animate: false,
    });
    try {
      for (const y of [null, -1, 0]) {
        const expected = await buildSchematicScene(
          selectLayer(schematic, y),
          assets,
          { animate: false },
        );
        assert.ok(expected);
        try {
          const selection = await layered.prepareLayer(y);
          assert.ok(selection);
          layered.show(selection);
          assertSameSurfaces(layered.group, expected.group);
        } finally {
          expected.dispose();
        }
      }
    } finally {
      await layered.dispose();
    }
  }
});

test("cached switches reuse geometry and eviction preserves active and staged selections", async () => {
  const layered = await buildLayeredScene(pillar("minecraft:stone"), assets, {
    animate: false,
    cacheEntries: 1,
  });
  try {
    const selected = await layered.prepareLayer(0);
    assert.ok(selected);
    layered.show(selected);
    const built = layered.stats.boundaryBuilds,
      bytes = layered.stats.cacheBytes;
    const cached = await layered.prepareLayer(0);
    assert.ok(cached);
    layered.show(cached);
    assert.equal(layered.stats.boundaryBuilds, built);
    const prefetched = await layered.prepareLayer(1);
    assert.ok(prefetched);
    const oldArea = surfaces(layered.group).area;
    layered.release(prefetched);
    assert.equal(surfaces(layered.group).area, oldArea);
    assert.equal(layered.stats.cacheBytes, bytes);
    const staged = await layered.prepareLayer(2);
    assert.ok(staged);
    const extra = await layered.prepareLayer(3);
    assert.ok(extra);
    layered.release(extra);
    layered.show(staged);
    assert.equal(surfaces(layered.group).area, (4 * 19 + 2) * 256);
    const beforeCancel = layered.stats.boundaryBuilds;
    assert.equal(await layered.prepareLayer(4, () => true), null);
    assert.equal(layered.stats.boundaryBuilds, beforeCancel);
    const all = await layered.prepareLayer(null);
    assert.ok(all);
    layered.show(all);
    assert.equal(layered.stats.boundaryBuilds, beforeCancel);
    assert.equal(layered.stats.bodyBuilds, 3);
  } finally {
    await layered.dispose();
  }
  assert.equal(layered.stats.cacheBytes, 0);
  assert.equal(layered.group.children.length, 0);
});
