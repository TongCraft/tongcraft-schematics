/** Exact Litematica NBT decoding, shared by the Worker and browser. */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_NBT_BYTES = 64 * 1024 * 1024;
export class SchematicError extends Error {}
function valid(ok: unknown, message: string): asserts ok {
  if (!ok) throw new SchematicError(message);
}
export type Vec3 = [number, number, number];
export interface BlockState {
  id: string;
  properties: Record<string, string>;
}
export interface Region {
  name: string;
  position: Vec3;
  size: Vec3;
  min: Vec3;
  max: Vec3;
}
export interface Schematic {
  volume: number;
  version: number;
  dataVersion: number;
  regions: Region[];
  solidBlocks: number;
  materials: { id: string; count: number }[];
  palette: BlockState[];
  /** Exact non-air blocks: [palette index, x, y, z, ...]. No resampling. */
  raw: Int32Array;
  blockNbt: Map<number, Record<string, unknown>>;
}
type Compound = Record<string, unknown>;
interface ArrayTag {
  type: number;
  length: number;
  start: number;
}

export function parseLitematic(data: Uint8Array, geometry = true): Schematic {
  valid(
    data.length > 0 && data.length <= MAX_NBT_BYTES,
    "蓝图解压后超过 64 MiB",
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  let offset = 0,
    nodes = 0;
  const take = (length: number) => {
    valid(
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
    const length = view.getUint16(take(2)),
      start = take(length);
    return decoder.decode(data.subarray(start, start + length));
  };
  const payload = (type: number, depth: number, keep = false): unknown => {
    valid(depth <= 32 && ++nodes <= 2_000_000, "蓝图 NBT 结构过于复杂");
    switch (type) {
      case 1:
        return view.getInt8(take(1));
      case 2:
        return view.getInt16(take(2));
      case 3:
        return int();
      case 4:
        return view.getBigInt64(take(8));
      case 5:
        return view.getFloat32(take(4));
      case 6:
        return view.getFloat64(take(8));
      case 7:
      case 11:
      case 12: {
        const length = int();
        valid(length >= 0, "蓝图 NBT 数组长度无效");
        const width = type === 7 ? 1 : type === 11 ? 4 : 8;
        const start = take(length * width);
        if (keep)
          return Array.from({ length }, (_, i) =>
            type === 7
              ? view.getInt8(start + i)
              : type === 11
                ? view.getInt32(start + i * 4)
                : view.getBigInt64(start + i * 8),
          );
        return { type, length, start };
      }
      case 8:
        return string();
      case 9: {
        const listType = byte(),
          length = int();
        valid(
          length >= 0 &&
            length <= 1_000_000 &&
            (listType !== 0 || length === 0),
          "蓝图 NBT 列表长度无效",
        );
        const values: unknown[] | undefined = keep ? [] : undefined;
        for (let i = 0; i < length; i++) {
          const value = payload(listType, depth + 1, keep);
          values?.push(value);
        }
        return keep ? values : { listType, length };
      }
      case 10: {
        const result: Compound = Object.create(null);
        for (;;) {
          const childType = byte();
          if (childType === 0) break;
          const name = string();
          result[name] = payload(
            childType,
            depth + 1,
            keep ||
              name === "BlockStatePalette" ||
              (geometry && name === "TileEntities"),
          );
        }
        return result;
      }
      default:
        throw new SchematicError("蓝图包含不支持的 NBT 类型");
    }
  };
  valid(byte() === 10, "蓝图缺少 NBT 根节点");
  string();
  const root = payload(10, 0) as Compound;
  valid(offset === data.length, "蓝图末尾有无效数据");
  valid(
    Number.isInteger(root.Version) &&
      Number(root.Version) >= 4 &&
      Number(root.Version) <= 7,
    "不支持此版本的 .litematic",
  );
  valid(
    root.Regions &&
      typeof root.Regions === "object" &&
      !Array.isArray(root.Regions),
    "蓝图没有区域",
  );
  const entries = Object.entries(root.Regions as Compound);
  valid(entries.length > 0 && entries.length <= 1024, "蓝图区域数量无效");
  const palette: BlockState[] = [],
    stateMap = new Map<string, number>();
  const regions: Region[] = [],
    counts = new Map<string, number>();
  const chunks: { raw: Int32Array; nbt: Map<number, Compound> }[] = [];
  let volume = 0,
    solidBlocks = 0;
  for (const [name, value] of entries) {
    valid(
      name.length > 0 &&
        name.length <= 256 &&
        value &&
        typeof value === "object",
      "蓝图区域名称或数据无效",
    );
    const region = value as Compound,
      states = region.BlockStates as ArrayTag;
    const localPalette = region.BlockStatePalette as Compound[];
    valid(
      states?.type === 12 &&
        Array.isArray(localPalette) &&
        localPalette.length > 0 &&
        localPalette.length <= 65536,
      "蓝图区域缺少方块数据",
    );
    const vector = (tag: unknown, size: boolean): Vec3 => {
      valid(tag && typeof tag === "object", "蓝图区域缺少坐标");
      const v = ["x", "y", "z"].map((axis) => (tag as Compound)[axis]);
      valid(
        v.every(
          (n) =>
            Number.isInteger(n) &&
            (size
              ? Math.abs(Number(n)) > 0 && Math.abs(Number(n)) <= 4096
              : Math.abs(Number(n)) <= 30_000_000),
        ),
        "蓝图区域尺寸或坐标无效",
      );
      return v as Vec3;
    };
    const size = vector(region.Size, true),
      position = vector(region.Position, false);
    // The container always runs from its minimum toward +XYZ. Negative Size
    // changes that corner; it does NOT reverse the packed block indexes.
    const min = position.map((p, a) => p + Math.min(0, size[a] + 1)) as Vec3;
    const max = min.map((p, a) => p + Math.abs(size[a]) - 1) as Vec3;
    const [dx, dy, dz] = size.map(Math.abs),
      cells = dx * dy * dz;
    volume += cells;
    valid(volume <= 32_000_000, "蓝图超过 3200 万方块");
    const bits = Math.max(2, Math.ceil(Math.log2(localPalette.length)));
    valid(
      states.length === Math.ceil((cells * bits) / 64),
      "蓝图方块数组长度无效",
    );
    const remap = localPalette.map((s) => {
      valid(
        typeof s?.Name === "string" &&
          /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(s.Name),
        "蓝图包含无效的方块名称",
      );
      const props = (s.Properties ?? {}) as Compound;
      valid(
        props && typeof props === "object" && !Array.isArray(props),
        "方块状态无效",
      );
      const properties: Record<string, string> = Object.create(null);
      for (const [key, val] of Object.entries(props).sort()) {
        valid(
          typeof val === "string" && key.length <= 128 && val.length <= 128,
          "方块状态无效",
        );
        properties[key] = val;
      }
      const state = { id: s.Name, properties },
        key = JSON.stringify(state);
      if (!stateMap.has(key)) {
        stateMap.set(key, palette.length);
        palette.push(state);
      }
      return stateMap.get(key)!;
    });
    // NBT longs are big endian; the bit container packs from the low bit.
    const word = (index: number) =>
      view.getUint32(
        states.start + Math.floor(index / 2) * 8 + (index % 2 === 0 ? 4 : 0),
      );
    const mask = (1 << bits) - 1;
    const stateAt = (i: number) => {
      const bit = i * bits,
        w = Math.floor(bit / 32),
        shift = bit % 32;
      let value = word(w) >>> shift;
      if (shift + bits > 32) value |= word(w + 1) << (32 - shift);
      const state = remap[value & mask];
      valid(state !== undefined, "蓝图方块索引超出调色板");
      return state;
    };
    const air = new Set(
      remap.filter((s) =>
        /^minecraft:(air|cave_air|void_air)$/.test(palette[s].id),
      ),
    );
    let count = 0;
    for (let i = 0; i < cells; i++) {
      const state = stateAt(i);
      if (air.has(state)) continue;
      count++;
      const id = palette[state].id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    solidBlocks += count;
    if (geometry) {
      // Later regions, including air, replace earlier overlapping cells.
      for (let r = 0; r < regions.length; r++) {
        if (
          !min.every(
            (n, a) => n <= regions[r].max[a] && max[a] >= regions[r].min[a],
          )
        )
          continue;
        const chunk = chunks[r],
          kept: number[] = [],
          nbt = new Map<number, Compound>();
        for (let i = 0; i < chunk.raw.length; i += 4) {
          if (
            [0, 1, 2].every(
              (a) =>
                chunk.raw[i + a + 1] >= min[a] &&
                chunk.raw[i + a + 1] <= max[a],
            )
          )
            continue;
          if (chunk.nbt.has(i / 4))
            nbt.set(kept.length / 4, chunk.nbt.get(i / 4)!);
          kept.push(
            chunk.raw[i],
            chunk.raw[i + 1],
            chunk.raw[i + 2],
            chunk.raw[i + 3],
          );
        }
        chunks[r] = { raw: Int32Array.from(kept), nbt };
      }
      const raw = new Int32Array(count * 4),
        nbt = new Map<number, Compound>();
      const tiles = new Map<number, Compound>();
      for (const tile of (Array.isArray(region.TileEntities)
        ? region.TileEntities
        : []) as Compound[]) {
        const [x, y, z] = [tile.x, tile.y, tile.z].map(Number);
        if (
          [x, y, z].every(Number.isInteger) &&
          x >= 0 &&
          y >= 0 &&
          z >= 0 &&
          x < dx &&
          y < dy &&
          z < dz
        )
          tiles.set(y * dx * dz + z * dx + x, tile);
      }
      let cursor = 0;
      for (let i = 0; i < cells; i++) {
        const state = stateAt(i);
        if (air.has(state)) continue;
        if (tiles.has(i)) nbt.set(cursor / 4, tiles.get(i)!);
        raw[cursor++] = state;
        raw[cursor++] = min[0] + (i % dx);
        raw[cursor++] = min[1] + Math.floor(i / (dx * dz));
        raw[cursor++] = min[2] + (Math.floor(i / dx) % dz);
      }
      chunks.push({ raw, nbt });
    }
    regions.push({ name, size, position, min, max });
  }
  const raw = new Int32Array(chunks.reduce((n, c) => n + c.raw.length, 0));
  const blockNbt = new Map<number, Compound>();
  let cursor = 0;
  for (const chunk of chunks) {
    for (const [i, nbt] of chunk.nbt) blockNbt.set(cursor / 4 + i, nbt);
    raw.set(chunk.raw, cursor);
    cursor += chunk.raw.length;
  }
  return {
    volume,
    version: Number(root.Version),
    dataVersion: Number(root.MinecraftDataVersion ?? 0),
    regions,
    solidBlocks,
    materials: [...counts]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)),
    palette,
    raw,
    blockNbt,
  };
}
