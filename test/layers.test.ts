import test from "node:test";
import assert from "node:assert/strict";
import { LayerUpdates, selectLayer } from "../shared/layers";
import type { Schematic } from "../shared/litematic";

const schematic: Schematic = {
  volume: 100,
  version: 7,
  dataVersion: 4671,
  solidBlocks: 4,
  materials: [],
  regions: [
    {
      name: "main",
      min: [20, -10, 30],
      max: [21, 10, 32],
      position: [20, -10, 30],
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
  raw: Int32Array.from([
    0, 20, -10, 30, 1, 21, 4, 31, 0, 20, -3, 32, 1, 21, 5, 32,
  ]),
  blockNbt: new Map([
    [1, { id: "top" }],
    [2, { id: "lower" }],
  ]),
};

test("layer selection removes higher blocks completely and retains the boundary layer", () => {
  const selected = selectLayer(schematic, -3);
  assert.deepEqual(Array.from(selected.raw), [0, 20, -10, 30, 0, 20, -3, 32]);
  assert.deepEqual([...selected.blockNbt], [[1, { id: "lower" }]]);
  assert.strictEqual(selected.regions, schematic.regions);
  assert.strictEqual(selected.palette, schematic.palette);
  assert.equal(schematic.raw.length, 16);
  assert.equal(schematic.blockNbt.size, 2);
  assert.deepEqual(
    Array.from(selectLayer(schematic, 4).raw),
    Array.from(schematic.raw.slice(0, 12)),
  );
});

test("all layers restore the source, and empty selections contain no leftover geometry input", () => {
  assert.strictEqual(selectLayer(schematic, null), schematic);
  assert.strictEqual(selectLayer(schematic, 10), schematic);
  const empty = selectLayer(schematic, -11);
  assert.equal(empty.raw.length, 0);
  assert.equal(empty.blockNbt.size, 0);
  assert.throws(() => selectLayer(schematic, NaN));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

test("rapid changes discard stale geometry and export waits for the latest layer", async () => {
  const firstStarted = deferred<void>(),
    secondStarted = deferred<void>(),
    firstDone = deferred<void>(),
    secondDone = deferred<void>();
  const applied: number[] = [],
    released: number[] = [],
    built: number[] = [];
  const updates = new LayerUpdates<number, { layer: number }>(
    async (layer, cancelled) => {
      built.push(layer);
      if (layer === 1) {
        firstStarted.resolve();
        await firstDone.promise;
        assert.equal(cancelled(), true);
      }
      if (layer === 3) {
        secondStarted.resolve();
        await secondDone.promise;
      }
      return { layer };
    },
    (result) => applied.push(result.layer),
    (result) => released.push(result.layer),
    0,
  );
  const first = updates.set(1);
  await firstStarted.promise;
  let exported = false;
  const capture = updates.settled().then(() => (exported = true));
  const skipped = updates.set(2),
    latest = updates.set(3);
  firstDone.resolve();
  await secondStarted.promise;
  assert.equal(exported, false);
  secondDone.resolve();
  await Promise.all([first, skipped, latest, capture]);
  assert.deepEqual(built, [1, 3]);
  assert.deepEqual(applied, [3]);
  assert.deepEqual(released, [1]);
  assert.equal(exported, true);
});

test("closing the viewer cancels work and releases a late scene", async () => {
  const started = deferred<void>(),
    done = deferred<void>();
  let applied = 0,
    released = 0;
  const updates = new LayerUpdates(
    async () => {
      started.resolve();
      await done.promise;
      return {};
    },
    () => applied++,
    () => released++,
    0,
  );
  const pending = updates.set(10);
  await started.promise;
  const closed = updates.dispose();
  done.resolve();
  await Promise.all([closed, pending, updates.set(20)]);
  assert.equal(applied, 0);
  assert.equal(released, 1);
});

test("a failed build does not prevent the next layer from rendering", async () => {
  const applied: number[] = [];
  const updates = new LayerUpdates<number, { layer: number }>(
    async (layer) => {
      if (layer === 1) throw new Error("failed");
      return { layer };
    },
    (result) => applied.push(result.layer),
    () => {},
    0,
  );
  await assert.rejects(updates.set(1), /failed/);
  await updates.set(2);
  assert.deepEqual(applied, [2]);
});
