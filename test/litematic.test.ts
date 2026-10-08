import test from "node:test";
import assert from "node:assert/strict";
import { parseLitematic, SchematicError, type Vec3 } from "../shared/litematic";

const str = (text: string) => {
  const b = Buffer.from(text),
    n = Buffer.alloc(2);
  n.writeUInt16BE(b.length);
  return Buffer.concat([n, b]);
};
const int = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const tag = (t: number, key: string, b: Buffer) =>
  Buffer.concat([Buffer.from([t]), str(key), b]);
const compound = (...fields: Buffer[]) =>
  Buffer.concat([...fields, Buffer.from([0])]);
const vector = (key: string, v: Vec3) =>
  tag(
    10,
    key,
    compound(...v.map((n, i) => tag(3, ["x", "y", "z"][i], int(n)))),
  );
const palette = [
  { id: "minecraft:air", properties: {} },
  { id: "minecraft:stone", properties: {} },
  {
    id: "minecraft:oak_stairs",
    properties: {
      facing: "east",
      half: "top",
      shape: "inner_left",
      waterlogged: "false",
    },
  },
  {
    id: "minecraft:oak_stairs",
    properties: {
      facing: "north",
      half: "bottom",
      shape: "straight",
      waterlogged: "true",
    },
  },
  {
    id: "minecraft:smooth_stone_slab",
    properties: { type: "top", waterlogged: "false" },
  },
];
function region(
  name: string,
  size: Vec3,
  pos: Vec3,
  indexes: number[],
  tiles: Buffer[] = [],
) {
  assert.equal(
    indexes.length,
    size.reduce((n, v) => n * Math.abs(v), 1),
  );
  const bits = Math.max(2, Math.ceil(Math.log2(palette.length))),
    words = Array<bigint>(Math.ceil((indexes.length * bits) / 64)).fill(0n);
  indexes.forEach((n, i) => {
    const bit = i * bits,
      w = Math.floor(bit / 64),
      s = bit % 64;
    words[w] |= BigInt(n) << BigInt(s);
    if (s + bits > 64) words[w + 1] |= BigInt(n) >> BigInt(64 - s);
  });
  const packed = Buffer.alloc(words.length * 8);
  words.forEach((n, i) =>
    packed.writeBigUInt64BE(BigInt.asUintN(64, n), i * 8),
  );
  return tag(
    10,
    name,
    compound(
      vector("Size", size),
      vector("Position", pos),
      tag(12, "BlockStates", Buffer.concat([int(words.length), packed])),
      tag(
        9,
        "BlockStatePalette",
        Buffer.concat([
          Buffer.from([10]),
          int(palette.length),
          ...palette.map((s) =>
            compound(
              tag(8, "Name", str(s.id)),
              tag(
                10,
                "Properties",
                compound(
                  ...Object.entries(s.properties).map(([k, v]) =>
                    tag(8, k, str(v)),
                  ),
                ),
              ),
            ),
          ),
        ]),
      ),
      tag(
        9,
        "TileEntities",
        Buffer.concat([Buffer.from([10]), int(tiles.length), ...tiles]),
      ),
    ),
  );
}
const file = (...regions: Buffer[]) =>
  tag(
    10,
    "",
    compound(
      tag(3, "Version", int(7)),
      tag(3, "MinecraftDataVersion", int(4671)),
      tag(10, "Regions", compound(...regions)),
    ),
  );
const blocks = (data: Uint8Array) => {
  const s = parseLitematic(data),
    result = [];
  for (let i = 0; i < s.raw.length; i += 4)
    result.push({
      state: s.palette[s.raw[i]],
      pos: Array.from(s.raw.subarray(i + 1, i + 4)),
    });
  return result;
};

test("retains stair orientation, slab state, holes and floating blocks", () => {
  const data = file(
    region(
      "test",
      [2, 3, 2],
      [10, 20, -4],
      [1, 0, 0, 0, 0, 0, 0, 2, 0, 3, 4, 0],
    ),
  );
  const rendered = blocks(data);
  assert.deepEqual(
    rendered.map((b) => b.pos),
    [
      [10, 20, -4],
      [11, 21, -3],
      [11, 22, -4],
      [10, 22, -3],
    ],
  );
  assert.deepEqual({ ...rendered[1].state.properties }, palette[2].properties);
  assert.deepEqual({ ...rendered[2].state.properties }, palette[3].properties);
  assert.equal(rendered[3].state.properties.type, "top");
  assert.equal(parseLitematic(data).raw.length / 4, 4);
});

test("negative size shifts the minimum corner without mirroring the block array", () => {
  const data = file(
    region(
      "negative",
      [-2, -2, -3],
      [8, 7, 6],
      [1, 2, 0, 3, 0, 0, 4, 0, 0, 0, 0, 1],
    ),
  );
  assert.deepEqual(parseLitematic(data).regions[0].min, [7, 6, 4]);
  assert.deepEqual(
    blocks(data).map((b) => b.pos),
    [
      [7, 6, 4],
      [8, 6, 4],
      [8, 6, 5],
      [7, 7, 4],
      [8, 7, 6],
    ],
  );
});

test("decodes palette indexes across both 32-bit and 64-bit boundaries", () => {
  const indexes = Array.from({ length: 100 }, (_, i) => (i * 7 + 3) % 5);
  const result = blocks(
    file(region("packed", [100, 1, 1], [0, 0, 0], indexes)),
  );
  assert.deepEqual(
    result.map((b) => [b.state.id, { ...b.state.properties }, b.pos[0]]),
    indexes.flatMap((n, i) =>
      n ? [[palette[n].id, palette[n].properties, i]] : [],
    ),
  );
});

test("preserves separate region offsets and lets later air clear overlapping cells", () => {
  const data = file(
    region("first", [3, 1, 1], [0, 0, 0], [1, 1, 1]),
    region("far", [1, 1, 1], [-50, 12, 90], [2]),
    region("overlap", [2, 1, 1], [1, 0, 0], [0, 4]),
  );
  const result = blocks(data);
  assert.deepEqual(
    result.map((b) => b.pos),
    [
      [0, 0, 0],
      [-50, 12, 90],
      [2, 0, 0],
    ],
  );
  assert.equal(result[2].state.id, "minecraft:smooth_stone_slab");
});

test("retains block entity NBT and maps it to its exact block", () => {
  const tile = compound(
    tag(3, "x", int(1)),
    tag(3, "y", int(0)),
    tag(3, "z", int(0)),
    tag(8, "id", str("minecraft:chest")),
    tag(
      9,
      "Items",
      Buffer.concat([
        Buffer.from([10]),
        int(1),
        compound(tag(8, "id", str("minecraft:stone"))),
      ]),
    ),
  );
  const s = parseLitematic(
    file(region("tile", [2, 1, 1], [100, 2, 3], [0, 1], [tile])),
  );
  assert.equal(s.blockNbt.size, 1);
  assert.equal(s.blockNbt.get(0)?.id, "minecraft:chest");
  assert.equal(
    (s.blockNbt.get(0)?.Items as Record<string, string>[])[0].id,
    "minecraft:stone",
  );
  assert.deepEqual(Array.from(s.raw.subarray(1)), [101, 2, 3]);
});

test("rejects invalid indexes rather than substituting an approximate block", () => {
  assert.throws(
    () => parseLitematic(file(region("bad", [1, 1, 1], [0, 0, 0], [7]))),
    SchematicError,
  );
});
