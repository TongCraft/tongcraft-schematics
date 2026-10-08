import test from "node:test";
import assert from "node:assert/strict";
import { LayerIndex } from "../shared/layer-index";
import type { Schematic } from "../shared/litematic";

function source(raw: number[]): Schematic {
  return {
    volume: 100,
    version: 7,
    dataVersion: 4671,
    solidBlocks: raw.length / 4,
    materials: [],
    regions: [
      {
        name: "main",
        min: [-20, -10, 30],
        max: [-19, 10, 32],
        position: [-20, -10, 30],
        size: [2, 21, 3],
      },
    ],
    palette: [
      { id: "minecraft:stone", properties: {} },
      {
        id: "minecraft:oak_stairs",
        properties: { facing: "east", half: "top", shape: "inner_left" },
      },
    ],
    raw: Int32Array.from(raw),
    blockNbt: new Map(),
  };
}

test("bands respect height and block budgets without losing dense or sparse layers", () => {
  const schematic = source([
    0, -20, -10, 30, 0, -19, -10, 30, 0, -20, -9, 30, 0, -19, -9, 30, 0, -20,
    -8, 30, 0, -19, -8, 30, 0, -20, -8, 31, 0, -19, -8, 31, 0, -20, -7, 30, 0,
    -20, 10, 30,
  ]);
  const index = new LayerIndex(schematic, 2, 3);
  assert.deepEqual(index.bands, [
    { low: -10, high: -10, count: 2 },
    { low: -9, high: -9, count: 2 },
    { low: -8, high: -8, count: 4 },
    { low: -7, high: -7, count: 1 },
    { low: 10, high: 10, count: 1 },
  ]);
  assert.equal(
    index.bands.reduce((n, b) => n + b.count, 0),
    10,
  );
  const heightLimited = new LayerIndex(schematic, 2, 100);
  assert.deepEqual(heightLimited.bands, [
    { low: -10, high: -9, count: 4 },
    { low: -8, high: -7, count: 5 },
    { low: 10, high: 10, count: 1 },
  ]);
});

test("body slices retain exact neighbour states as non-rendered context and remap NBT", () => {
  const schematic = source([0, -20, -4, 30, 1, -19, -2, 31, 0, -20, -3, 32]);
  schematic.blockNbt.set(0, { id: "below" });
  schematic.blockNbt.set(1, { id: "above" });
  const slice = new LayerIndex(schematic).slice(-3, -3);
  assert.deepEqual(
    Array.from(slice.raw),
    [2, -20, -4, 30, 0, -20, -3, 32, 3, -19, -2, 31],
  );
  assert.equal(slice.palette[0].id, "minecraft:stone");
  assert.equal(slice.palette[2].id, "minecraft:stone");
  assert.equal((slice.palette[2] as { context?: boolean }).context, true);
  assert.equal((slice.palette[3] as { context?: boolean }).context, true);
  assert.deepEqual(slice.palette[3].properties, {
    facing: "east",
    half: "top",
    shape: "inner_left",
  });
  assert.deepEqual(
    [...slice.blockNbt],
    [
      [0, { id: "below" }],
      [2, { id: "above" }],
    ],
  );
  assert.strictEqual(slice.regions, schematic.regions);
  assert.equal(schematic.palette.length, 2);
  assert.equal(schematic.raw[0], 0);
});

test("top slices remove all higher context so the newly exposed face is visible", () => {
  const schematic = source([0, -20, -4, 30, 1, -19, -2, 31, 0, -20, -3, 32]);
  schematic.blockNbt.set(1, { id: "hidden" });
  const top = new LayerIndex(schematic).slice(-3, -3, false);
  assert.deepEqual(Array.from(top.raw), [2, -20, -4, 30, 0, -20, -3, 32]);
  assert.equal(top.blockNbt.size, 0);
});

test("counts handle negative coordinates, gaps, empty cutoffs and restoration", () => {
  const index = new LayerIndex(
    source([0, -20, 10, 30, 1, -19, -10, 31, 0, -20, -3, 32]),
  );
  assert.equal(index.count(-11), 0);
  assert.equal(index.count(-10), 1);
  assert.equal(index.count(-4), 1);
  assert.equal(index.count(-3), 2);
  assert.equal(index.count(0), 2);
  assert.equal(index.count(10), 3);
  assert.equal(index.count(null), 3);
  assert.equal(new LayerIndex(source([])).count(null), 0);
});
