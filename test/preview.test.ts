import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PREVIEW_BYTES, validatePreview } from "../src/preview";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
  "base64",
);

test("accepts a static PNG and rejects arbitrary or truncated content", () => {
  validatePreview(png);
  for (const bytes of [
    Buffer.from("<svg></svg>"),
    png.subarray(0, 33),
    png.subarray(0, png.length - 1),
    Buffer.concat([png, Buffer.from([0])]),
  ])
    assert.throws(() => validatePreview(bytes));
});

test("rejects oversized files and PNGs with unsafe decoded dimensions", () => {
  assert.throws(() => validatePreview(Buffer.alloc(MAX_PREVIEW_BYTES + 1)));
  for (const dimension of [0, 1025, 0xffffffff]) {
    const invalid = Buffer.from(png);
    invalid.writeUInt32BE(dimension, 16);
    assert.throws(() => validatePreview(invalid));
  }
});
