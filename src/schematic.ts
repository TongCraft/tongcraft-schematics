import { gunzipSync } from "node:zlib";
import {
  MAX_FILE_BYTES,
  MAX_NBT_BYTES,
  SchematicError,
  parseLitematic,
} from "../shared/litematic";
export { MAX_FILE_BYTES, SchematicError } from "../shared/litematic";

export function validateLitematic(compressed: Uint8Array) {
  if (!compressed.byteLength || compressed.byteLength > MAX_FILE_BYTES)
    throw new SchematicError("蓝图须小于 16 MiB");
  let data: Uint8Array;
  try {
    data = gunzipSync(compressed, { maxOutputLength: MAX_NBT_BYTES });
  } catch {
    throw new SchematicError("文件不是有效的 .litematic，或解压后超过 64 MiB");
  }
  const parsed = parseLitematic(data, false);
  return { ...parsed, regions: parsed.regions.map((r) => r.name) };
}
