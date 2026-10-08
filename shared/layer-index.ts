import type { BlockState, Schematic } from "./litematic";

export interface LayerBand {
  low: number;
  high: number;
  count: number;
}

/** Index once; subsequent slices visit only their own layers and neighbour halo. */
export class LayerIndex {
  readonly rows = new Map<number, Uint32Array>();
  readonly heights: number[];
  readonly bands: LayerBand[] = [];
  readonly palette: (BlockState & { context?: boolean })[];
  private totals: number[] = [];

  constructor(
    readonly source: Schematic,
    maxHeight = 16,
    maxBlocks = 24_576,
  ) {
    const rows = new Map<number, number[]>();
    for (let i = 0; i < source.raw.length; i += 4) {
      const y = source.raw[i + 2];
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push(i / 4);
    }
    this.heights = [...rows.keys()].sort((a, b) => a - b);
    let total = 0;
    for (const y of this.heights) {
      const row = Uint32Array.from(rows.get(y)!);
      this.rows.set(y, row);
      total += row.length;
      this.totals.push(total);
      let band = this.bands.at(-1);
      if (
        !band ||
        y - band.low >= maxHeight ||
        band.count + row.length > maxBlocks
      ) {
        band = { low: y, high: y, count: 0 };
        this.bands.push(band);
      }
      band.high = y;
      band.count += row.length;
    }
    this.palette = [
      ...source.palette,
      ...source.palette.map((state) => ({ ...state, context: true })),
    ];
  }

  count(y: number | null): number {
    if (y === null) return this.source.raw.length / 4;
    let low = 0,
      high = this.heights.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.heights[mid] <= y) low = mid + 1;
      else high = mid;
    }
    return low ? this.totals[low - 1] : 0;
  }

  /** Halo blocks affect culling/fluids, but context=true emits no geometry. */
  slice(low: number, high: number, aboveContext = true): Schematic {
    const rows: { indices: Uint32Array; context: boolean }[] = [];
    const append = (y: number, context: boolean) => {
      const indices = this.rows.get(y);
      if (indices) rows.push({ indices, context });
    };
    append(low - 1, true);
    for (const y of this.heights) {
      if (y < low) continue;
      if (y > high) break;
      append(y, false);
    }
    if (aboveContext) append(high + 1, true);
    const raw = new Int32Array(
      rows.reduce((n, r) => n + r.indices.length * 4, 0),
    );
    const blockNbt = new Map<number, Record<string, unknown>>();
    let cursor = 0;
    for (const { indices, context } of rows)
      for (const index of indices) {
        const start = index * 4,
          nbt = this.source.blockNbt.get(index);
        if (nbt) blockNbt.set(cursor / 4, nbt);
        raw[cursor++] =
          this.source.raw[start] + (context ? this.source.palette.length : 0);
        raw[cursor++] = this.source.raw[start + 1];
        raw[cursor++] = this.source.raw[start + 2];
        raw[cursor++] = this.source.raw[start + 3];
      }
    return { ...this.source, palette: this.palette, raw, blockNbt };
  }
}
