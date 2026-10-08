import type { Schematic } from "./litematic";

/** Select whole blocks before meshing so exposed faces are culled correctly. */
export function selectLayer(schematic: Schematic, y: number | null): Schematic {
  if (y === null) return schematic;
  if (!Number.isSafeInteger(y)) throw new Error("层高度必须是整数");
  let count = 0;
  for (let i = 0; i < schematic.raw.length; i += 4)
    if (schematic.raw[i + 2] <= y) count++;
  if (count * 4 === schematic.raw.length) return schematic;
  const raw = new Int32Array(count * 4);
  const blockNbt = new Map<number, Record<string, unknown>>();
  let cursor = 0;
  for (let i = 0; i < schematic.raw.length; i += 4) {
    if (schematic.raw[i + 2] > y) continue;
    const nbt = schematic.blockNbt.get(i / 4);
    if (nbt) blockNbt.set(cursor / 4, nbt);
    raw.set(schematic.raw.subarray(i, i + 4), cursor);
    cursor += 4;
  }
  // Retain the original region origin for texture variants and camera position.
  return { ...schematic, raw, blockNbt };
}

/** Serialize expensive builds and publish only the latest requested layer. */
export class LayerUpdates<Value, Result> {
  private revision = 0;
  private closed = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(
    private build: (
      value: Value,
      cancelled: () => boolean,
    ) => Promise<Result | null>,
    private apply: (result: Result, value: Value) => void,
    private release: (result: Result) => void,
    private delay = 150,
  ) {}

  set(value: Value): Promise<void> {
    if (this.closed) return Promise.resolve();
    const revision = ++this.revision;
    const cancelled = () => this.closed || revision !== this.revision;
    this.pending = this.pending
      .catch(() => {})
      .then(async () => {
        if (cancelled()) return;
        if (this.delay)
          await new Promise((done) => setTimeout(done, this.delay));
        if (cancelled()) return;
        let result: Result | null;
        try {
          result = await this.build(value, cancelled);
        } catch (error) {
          if (cancelled()) return;
          throw error;
        }
        if (result === null) return;
        if (cancelled()) {
          this.release(result);
          return;
        }
        this.apply(result, value);
      });
    return this.pending;
  }

  async settled(): Promise<void> {
    // An export must wait for the current selection even if it changes while
    // an older build is settling.
    for (;;) {
      const pending = this.pending;
      try {
        await pending;
      } catch (error) {
        if (pending === this.pending) throw error;
      }
      if (pending === this.pending) return;
    }
  }

  dispose(): Promise<void> {
    this.closed = true;
    this.revision++;
    return this.pending.catch(() => {});
  }
}
