import * as THREE from "three";
import {
  createSharedAtlas,
  type AssetsInput,
  type CreateSceneOptions,
  type SceneHandle,
  type SharedAtlas,
} from "block-model-renderer";
import type { Schematic } from "./litematic";
import { LayerIndex, type LayerBand } from "./layer-index";
import { buildSchematicScene } from "./render-scene";

interface Piece {
  key: string;
  handle: SceneHandle;
  bytes: number;
  pins: number;
}
export interface LayerSelection {
  y: number | null;
  pieces: Piece[];
  consumed: boolean;
}
interface LayeredOptions {
  renderer?: THREE.WebGLRenderer;
  animate?: boolean;
  shouldCancel?: () => boolean;
  onProgress?: (text: string) => void;
  cacheBytes?: number;
  cacheEntries?: number;
}

function geometryBytes(group: THREE.Group) {
  const seen = new Set<THREE.BufferGeometry>();
  let bytes = 0;
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || seen.has(mesh.geometry)) return;
    seen.add(mesh.geometry);
    for (const attribute of Object.values(mesh.geometry.attributes))
      bytes += attribute.array.byteLength;
    bytes += mesh.geometry.index?.array.byteLength ?? 0;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh)
      bytes += (mesh as THREE.InstancedMesh).instanceMatrix.array.byteLength;
  });
  return bytes;
}

/** Persistent body bands plus lazily built partial band and top layer. */
export class LayeredScene {
  readonly group = new THREE.Group();
  readonly bounds = new THREE.Box3();
  readonly index: LayerIndex;
  readonly stats = {
    bodyBuilds: 0,
    boundaryBuilds: 0,
    cacheHits: 0,
    boundaryBlocks: 0,
    cacheBytes: 0,
  };
  private bodies: { band: LayerBand; handle: SceneHandle }[] = [];
  private cache = new Map<string, Piece>();
  private active: Piece[] = [];
  private currentY: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing?: Promise<void>;
  private atlas: SharedAtlas;

  constructor(
    private schematic: Schematic,
    private assets: AssetsInput,
    private options: LayeredOptions,
  ) {
    this.index = new LayerIndex(schematic);
    this.atlas = createSharedAtlas({
      renderer: options.renderer,
      animate: options.animate !== false,
    });
  }

  get visibleBlocks() {
    return this.index.count(this.currentY);
  }
  private build(slice: Schematic, cancelled: () => boolean) {
    // sliceMs is supported by the installed renderer, but omitted from its
    // public declarations. Keep work slices short during interactive loads.
    const options: CreateSceneOptions & { sliceMs: number } = {
      sharedAtlas: this.atlas,
      animate: this.options.animate !== false,
      sliceMs: 4,
      shouldCancel: () =>
        this.closed || cancelled() || Boolean(this.options.shouldCancel?.()),
    };
    return buildSchematicScene(slice, this.assets, options, true);
  }

  async initialize() {
    try {
      for (const band of this.index.bands) {
        const handle = await this.build(
          this.index.slice(band.low, band.high),
          () => false,
        );
        if (!handle) throw new DOMException("渲染已取消", "AbortError");
        this.bodies.push({ band, handle });
        this.group.add(handle.group);
        this.stats.bodyBuilds++;
        this.options.onProgress?.(
          `加载主体 ${this.bodies.length}/${this.index.bands.length}`,
        );
      }
      this.bounds.setFromObject(this.group);
      if (this.bounds.isEmpty()) throw new Error("投影中没有可见的方块模型");
      return this;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  private touch(piece: Piece) {
    this.cache.delete(piece.key);
    this.cache.set(piece.key, piece);
    return piece;
  }

  private async obtain(
    key: string,
    low: number,
    high: number,
    above: boolean,
    cancelled: () => boolean,
  ): Promise<Piece | null> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (this.closed || cancelled()) return null;
        const cached = this.cache.get(key);
        if (cached) {
          this.stats.cacheHits++;
          cached.pins++;
          return this.touch(cached);
        }
        const slice = this.index.slice(low, high, above);
        const handle = await this.build(slice, cancelled);
        if (!handle) return null;
        if (this.closed || cancelled()) {
          handle.dispose();
          return null;
        }
        handle.group.visible = false;
        this.group.add(handle.group);
        const piece = {
          key,
          handle,
          bytes: geometryBytes(handle.group),
          pins: 1,
        };
        this.cache.set(key, piece);
        this.stats.boundaryBuilds++;
        this.stats.boundaryBlocks +=
          this.index.count(high) - this.index.count(low - 1);
        this.stats.cacheBytes += piece.bytes;
        return piece;
      });
    this.queue = task;
    return task;
  }

  async prepareLayer(
    y: number | null,
    cancelled: () => boolean = () => false,
  ): Promise<LayerSelection | null> {
    if (y !== null && !Number.isSafeInteger(y))
      throw new Error("层高度必须是整数");
    if (this.closed || cancelled()) return null;
    if (y === null || y >= this.index.heights.at(-1)!)
      return { y: null, pieces: [], consumed: false };
    const selection: LayerSelection = { y, pieces: [], consumed: false };
    const band = this.index.bands.find((b) => b.low <= y && b.high >= y);
    if (!band) return selection;
    try {
      for (const [key, low, high, above] of [
        [`body:${band.low}:${y - 1}`, band.low, y - 1, true],
        [`top:${y}`, y, y, false],
      ] as const) {
        if (high < low || this.index.count(high) === this.index.count(low - 1))
          continue;
        const piece = await this.obtain(key, low, high, above, cancelled);
        if (!piece) {
          this.release(selection);
          return null;
        }
        selection.pieces.push(piece);
      }
      if (this.closed || cancelled()) {
        this.release(selection);
        return null;
      }
      return selection;
    } catch (error) {
      this.release(selection);
      throw error;
    }
  }

  show(selection: LayerSelection) {
    if (this.closed || selection.consumed) return;
    for (const piece of this.active) {
      piece.pins--;
      piece.handle.group.visible = false;
    }
    this.active = selection.pieces;
    selection.consumed = true;
    this.currentY = selection.y;
    for (const { band, handle } of this.bodies)
      handle.group.visible = selection.y === null || band.high < selection.y;
    for (const piece of this.active) {
      piece.handle.group.visible = true;
      this.touch(piece);
    }
    this.trim();
  }

  release(selection: LayerSelection) {
    if (selection.consumed) return;
    selection.consumed = true;
    for (const piece of selection.pieces) piece.pins--;
    this.trim();
  }

  private trim() {
    for (const [key, piece] of this.cache) {
      if (
        this.cache.size <= (this.options.cacheEntries ?? 16) &&
        this.stats.cacheBytes <= (this.options.cacheBytes ?? 32 * 1024 * 1024)
      )
        break;
      if (piece.pins) continue;
      this.cache.delete(key);
      this.stats.cacheBytes -= piece.bytes;
      piece.handle.dispose();
    }
  }

  sortTranslucent(camera: THREE.Camera) {
    for (const { handle } of this.bodies)
      if (handle.group.visible) handle.sortTranslucent(camera);
    for (const piece of this.active) piece.handle.sortTranslucent(camera);
  }

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.atlas.animation?.dispose();
    this.closing = this.queue
      .catch(() => {})
      .then(() => {
        for (const { handle } of this.bodies) handle.dispose();
        for (const piece of this.cache.values()) piece.handle.dispose();
        this.bodies = [];
        this.cache.clear();
        this.active = [];
        this.stats.cacheBytes = 0;
        this.atlas.dispose();
        this.group.removeFromParent();
      });
    return this.closing;
  }
}

export async function buildLayeredScene(
  schematic: Schematic,
  assets: AssetsInput,
  options: LayeredOptions = {},
) {
  return new LayeredScene(schematic, assets, options).initialize();
}
