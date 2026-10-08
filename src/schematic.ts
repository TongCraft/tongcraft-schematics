import { gunzipSync } from "node:zlib";
import { makePreviewSvg, type PreviewColumn } from "./preview";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_NBT_BYTES = 64 * 1024 * 1024;

export class SchematicError extends Error {}

function requireValid(ok: unknown, message: string): asserts ok {
  if (!ok) throw new SchematicError(message);
}

/** Reads just the structural NBT fields needed for safe cataloguing. Large arrays are skipped. */
export function validateLitematic(compressed: Uint8Array): {
  volume: number;
  regions: string[];
  version: number;
  solidBlocks: number;
  materials: { id: string; count: number }[];
  previewSvg: string;
} {
  requireValid(
    compressed.byteLength > 0 && compressed.byteLength <= MAX_FILE_BYTES,
    "蓝图须小于 16 MiB",
  );
  let data: Uint8Array;
  try {
    data = gunzipSync(compressed, { maxOutputLength: MAX_NBT_BYTES });
  } catch {
    throw new SchematicError("文件不是有效的 .litematic，或解压后超过 64 MiB");
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  let nodes = 0;
  const take = (length: number): number => {
    requireValid(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        offset + length <= data.length,
      "蓝图 NBT 数据不完整",
    );
    const start = offset;
    offset += length;
    return start;
  };
  const byte = () => view.getUint8(take(1));
  const int = () => view.getInt32(take(4));
  const string = () => {
    const length = view.getUint16(take(2));
    const start = take(length);
    return decoder.decode(data.subarray(start, start + length));
  };
  const payload = (type: number, depth: number, keepList = false): unknown => {
    requireValid(depth <= 32 && ++nodes <= 2_000_000, "蓝图 NBT 结构过于复杂");
    switch (type) {
      case 1:
        return view.getInt8(take(1));
      case 2:
        return view.getInt16(take(2));
      case 3:
        return int();
      case 4:
        take(8);
        return null;
      case 5:
        take(4);
        return null;
      case 6:
        take(8);
        return null;
      case 7:
      case 11:
      case 12: {
        const length = int();
        requireValid(length >= 0, "蓝图 NBT 数组长度无效");
        const start = take(
          length * ({ 7: 1, 11: 4, 12: 8 } as Record<number, number>)[type],
        );
        return { type, length, start };
      }
      case 8:
        return string();
      case 9: {
        const listType = byte();
        const length = int();
        requireValid(
          length >= 0 &&
            length <= 1_000_000 &&
            (listType !== 0 || length === 0),
          "蓝图 NBT 列表长度无效",
        );
        const values: unknown[] | undefined = keepList ? [] : undefined;
        for (let i = 0; i < length; i++) {
          const value = payload(listType, depth + 1);
          if (values) values.push(value);
        }
        return { listType, length, values };
      }
      case 10: {
        const result: Record<string, unknown> = Object.create(null);
        for (;;) {
          const childType = byte();
          if (childType === 0) break;
          const name = string();
          result[name] = payload(
            childType,
            depth + 1,
            name === "BlockStatePalette",
          );
        }
        return result;
      }
      default:
        throw new SchematicError("蓝图包含不支持的 NBT 类型");
    }
  };

  requireValid(byte() === 10, "蓝图缺少 NBT 根节点");
  string();
  const root = payload(10, 0) as Record<string, unknown>;
  requireValid(offset === data.length, "蓝图末尾有无效数据");
  const version = root.Version;
  requireValid(
    Number.isInteger(version) &&
      (version as number) >= 4 &&
      (version as number) <= 7,
    "不支持此版本的 .litematic",
  );
  const regionMap = root.Regions as Record<string, unknown> | undefined;
  requireValid(
    regionMap && typeof regionMap === "object" && !Array.isArray(regionMap),
    "蓝图没有区域",
  );
  const entries = Object.entries(regionMap);
  requireValid(
    entries.length > 0 && entries.length <= 1024,
    "蓝图区域数量无效",
  );
  let volume = 0;
  const regions: {
    position: number[];
    dimensions: number[];
    states: { length: number; start: number };
    palette: string[];
  }[] = [];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const [name, rawRegion] of entries) {
    requireValid(name.length > 0 && name.length <= 256, "蓝图区域名称无效");
    const region = rawRegion as Record<string, unknown>;
    requireValid(region && typeof region === "object", "蓝图区域无效");
    const size = region.Size as Record<string, unknown> | undefined;
    const position = region.Position as Record<string, unknown> | undefined;
    const states = region.BlockStates as
      { type?: number; length?: number; start?: number } | undefined;
    const palette = region.BlockStatePalette as
      { listType?: number; length?: number; values?: unknown[] } | undefined;
    requireValid(
      size &&
        position &&
        states?.type === 12 &&
        typeof states.start === "number" &&
        palette?.listType === 10 &&
        Array.isArray(palette.values),
      "蓝图区域缺少方块数据",
    );
    requireValid(
      typeof palette.length === "number" &&
        palette.length > 0 &&
        palette.length <= 65536,
      "蓝图方块调色板无效",
    );
    const dimensions = ["x", "y", "z"].map((axis) => size[axis]);
    requireValid(
      dimensions.every(
        (n) =>
          Number.isInteger(n) &&
          Math.abs(n as number) > 0 &&
          Math.abs(n as number) <= 4096,
      ),
      "蓝图区域尺寸无效",
    );
    requireValid(
      ["x", "y", "z"].every(
        (axis) =>
          Number.isSafeInteger(position[axis]) &&
          Math.abs(position[axis] as number) <= 30_000_000,
      ),
      "蓝图区域坐标无效",
    );
    const blocks = dimensions.reduce<number>(
      (count, n) => count * Math.abs(n as number),
      1,
    );
    volume += blocks;
    requireValid(volume <= 32_000_000, "蓝图超过 3200 万方块");
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    requireValid(
      states.length === Math.ceil((blocks * bits) / 64),
      "蓝图方块数组长度无效",
    );
    const names = palette.values.map(
      (value) => (value as Record<string, unknown>)?.Name,
    );
    requireValid(
      names.every(
        (value) =>
          typeof value === "string" &&
          /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(value),
      ),
      "蓝图包含无效的方块名称",
    );
    const coordinates = ["x", "y", "z"].map((axis) => position[axis] as number);
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(
        minimum[axis],
        coordinates[axis],
        coordinates[axis] +
          (dimensions[axis] as number) -
          Math.sign(dimensions[axis] as number),
      );
      maximum[axis] = Math.max(
        maximum[axis],
        coordinates[axis],
        coordinates[axis] +
          (dimensions[axis] as number) -
          Math.sign(dimensions[axis] as number),
      );
    }
    regions.push({
      position: coordinates,
      dimensions: dimensions as number[],
      states: states as { length: number; start: number },
      palette: names as string[],
    });
  }
  const counts = new Map<string, number>();
  let solidBlocks = 0;
  const columns = new Map<number, PreviewColumn>();
  const gridSize = 24;
  for (const region of regions) {
    const [dx, dy, dz] = region.dimensions.map(Math.abs);
    const signs = region.dimensions.map(Math.sign);
    const bits = Math.max(2, Math.ceil(Math.log2(region.palette.length)));
    const mask = (1n << BigInt(bits)) - 1n;
    let cachedIndex = -1;
    let cachedWord = 0n;
    for (let index = 0; index < dx * dy * dz; index++) {
      const bit = index * bits;
      const wordIndex = Math.floor(bit / 64);
      const shift = bit % 64;
      if (wordIndex !== cachedIndex) {
        cachedWord = view.getBigUint64(region.states.start + wordIndex * 8);
        cachedIndex = wordIndex;
      }
      let value = cachedWord >> BigInt(shift);
      if (shift + bits > 64) {
        value |=
          view.getBigUint64(region.states.start + (wordIndex + 1) * 8) <<
          BigInt(64 - shift);
      }
      const name = region.palette[Number(value & mask)];
      requireValid(name, "蓝图方块索引超出调色板");
      if (
        name === "minecraft:air" ||
        name === "minecraft:cave_air" ||
        name === "minecraft:void_air"
      )
        continue;
      solidBlocks++;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const x = index % dx;
      const z = Math.floor(index / dx) % dz;
      const y = Math.floor(index / (dx * dz));
      const worldX = region.position[0] + x * signs[0];
      const worldY = region.position[1] + y * signs[1];
      const worldZ = region.position[2] + z * signs[2];
      const px = Math.min(
        gridSize - 1,
        Math.floor(
          ((worldX - minimum[0]) * gridSize) / (maximum[0] - minimum[0] + 1),
        ),
      );
      const pz = Math.min(
        gridSize - 1,
        Math.floor(
          ((worldZ - minimum[2]) * gridSize) / (maximum[2] - minimum[2] + 1),
        ),
      );
      const key = px + pz * gridSize;
      if (!columns.has(key) || columns.get(key)!.height < worldY)
        columns.set(key, { x: px, z: pz, height: worldY, id: name });
    }
  }
  return {
    volume,
    regions: entries.map(([name]) => name),
    version: version as number,
    solidBlocks,
    materials: [...counts]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    previewSvg: makePreviewSvg([...columns.values()], minimum[1], maximum[1]),
  };
}
