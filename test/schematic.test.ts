import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  MAX_FILE_BYTES,
  SchematicError,
  validateLitematic,
} from "../src/schematic";

const str = (text: string) => {
  const value = Buffer.from(text);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(value.length);
  return Buffer.concat([length, value]);
};
const int = (value: number) => {
  const data = Buffer.alloc(4);
  data.writeInt32BE(value);
  return data;
};
const tag = (type: number, name: string, value: Buffer) =>
  Buffer.concat([Buffer.from([type]), str(name), value]);
const compound = (fields: Buffer[]) =>
  Buffer.concat([...fields, Buffer.from([0])]);
const position = (name: string, value: number) =>
  tag(
    10,
    name,
    compound(["x", "y", "z"].map((axis) => tag(3, axis, int(value)))),
  );

function fixture({
  version = 7,
  stateLength = 1,
  size = 1,
  state = 0,
} = {}): Buffer {
  const region = compound([
    position("Position", 0),
    position("Size", size),
    tag(
      12,
      "BlockStates",
      Buffer.concat([int(stateLength), Buffer.alloc(stateLength * 8, state)]),
    ),
    tag(
      9,
      "BlockStatePalette",
      Buffer.concat([
        Buffer.from([10]),
        int(2),
        compound([tag(8, "Name", str("minecraft:air"))]),
        compound([tag(8, "Name", str("minecraft:stone"))]),
      ]),
    ),
  ]);
  return gzipSync(
    tag(
      10,
      "",
      compound([
        tag(3, "Version", int(version)),
        tag(10, "Regions", compound([tag(10, "Main", region)])),
      ]),
    ),
  );
}

test("accepts a valid bounded Litematica file and extracts geometry", () => {
  const result = validateLitematic(fixture({ state: 1 }));
  assert.equal(result.version, 7);
  assert.equal(result.volume, 1);
  assert.equal(result.solidBlocks, 1);
  assert.deepEqual(result.regions, ["Main"]);
  assert.deepEqual(result.materials, [{ id: "minecraft:stone", count: 1 }]);
  assert.match(result.previewSvg, /^<svg/);
});

test("rejects malformed and unsupported schematics", () => {
  for (const input of [
    Buffer.from("not gzip"),
    fixture({ version: 8 }),
    fixture({ stateLength: 2 }),
    fixture({ size: 0 }),
  ])
    assert.throws(() => validateLitematic(input), SchematicError);
});

test("enforces the upload byte limit before decompression", () => {
  assert.throws(
    () => validateLitematic(new Uint8Array(MAX_FILE_BYTES + 1)),
    SchematicError,
  );
});
