import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  configure,
  prepareAssets,
  disposeCache,
  type AssetsInput,
} from "block-model-renderer";
import {
  MAX_FILE_BYTES,
  MAX_NBT_BYTES,
  parseLitematic,
  type Schematic,
} from "../shared/litematic";
import { buildSchematicScene, fitCamera } from "../shared/render-scene";
import { LayerUpdates } from "../shared/layers";
import {
  buildLayeredScene,
  LayeredScene,
  type LayerSelection,
} from "../shared/render-layers";
import type { SceneHandle } from "block-model-renderer";

configure({ THREE, assetsUrl: "/assets/renderer.zip" });
let defaultAssets: Promise<AssetsInput> | undefined;
let defaultMetadata: Promise<{ version: string; sha1: string }> | undefined;
let vanillaBytes: Uint8Array;
const fileCache = new Map<string, Uint8Array>();
const inFlight = new Map<string, Promise<Uint8Array>>();
export interface CatalogItem {
  id: string;
  sha256: string;
  downloadUrl: string;
}
export interface RenderOptions {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  resourcePack?: File;
  interactive?: boolean;
}
export interface Viewer {
  schematic: Schematic;
  reset(): void;
  setLayer(y: number | null): Promise<void>;
  capture(): Promise<Blob>;
  dispose(): void;
}
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();

function minecraftMetadata() {
  defaultMetadata ??= fetch("/assets/minecraft.json")
    .then(async (response) => {
      if (!response.ok) throw new Error("无法载入 Minecraft 资源，请重试");
      return response.json() as Promise<{ version: string; sha1: string }>;
    })
    .catch((error) => {
      defaultMetadata = undefined;
      throw error;
    });
  return defaultMetadata;
}

async function assets(pack?: File): Promise<AssetsInput> {
  if (pack) {
    if (pack.size > 64 * 1024 * 1024) throw new Error("资源包不能超过 64 MiB");
    await assets();
    return prepareAssets(
      [new Uint8Array(await pack.arrayBuffer()), vanillaBytes],
      {
        cache: true,
        defaults: "game",
        version: (await minecraftMetadata()).version,
      },
    );
  }
  defaultAssets ??= (async () => {
    const [response, { version }] = await Promise.all([
      fetch("/assets/vanilla.zip"),
      minecraftMetadata(),
    ]);
    if (!response.ok) throw new Error("无法载入 Minecraft 资源，请重试");
    vanillaBytes = new Uint8Array(await response.arrayBuffer());
    return prepareAssets(vanillaBytes, {
      cache: true,
      defaults: "game",
      version,
    });
  })().catch((error) => {
    defaultAssets = undefined;
    throw error;
  });
  return defaultAssets;
}

export async function decodeSchematic(
  compressed: Uint8Array,
): Promise<Schematic> {
  if (!compressed.length || compressed.length > MAX_FILE_BYTES)
    throw new Error("投影文件不能超过 16 MiB");
  const stream = new Blob([new Uint8Array(compressed).buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_NBT_BYTES) throw new Error("投影解压后超过 64 MiB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return parseLitematic(data);
}

/** Reuse downloaded bytes between a card and its 3D view, with a 32 MiB cap. */
export async function loadSchematic(item: CatalogItem): Promise<Uint8Array> {
  const key = item.sha256;
  if (fileCache.has(key)) return fileCache.get(key)!;
  if (inFlight.has(key)) return inFlight.get(key)!;
  const task = (async () => {
    const response = await fetch(item.downloadUrl);
    if (!response.ok) throw new Error(`投影读取失败 (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES)
      throw new Error("投影文件不能超过 16 MiB");
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    if (
      Array.from(new Uint8Array(hash), (n) =>
        n.toString(16).padStart(2, "0"),
      ).join("") !== key
    )
      throw new Error("投影校验失败，请重新下载");
    fileCache.set(key, bytes);
    while (
      [...fileCache.values()].reduce((n, b) => n + b.length, 0) >
      32 * 1024 * 1024
    )
      fileCache.delete(fileCache.keys().next().value!);
    return bytes;
  })();
  inFlight.set(key, task);
  try {
    return await task;
  } finally {
    inFlight.delete(key);
  }
}

/** Render all original block coordinates with their resource-pack geometry. */
export async function renderSchematic(
  container: HTMLElement,
  compressed: Uint8Array,
  options: RenderOptions = {},
): Promise<Viewer> {
  const { signal, onProgress = () => {} } = options;
  abort(signal);
  onProgress("读取投影与 Minecraft 资源…");
  const [schematic, resources] = await Promise.all([
    decodeSchematic(compressed),
    assets(options.resourcePack),
  ]);
  let renderer: THREE.WebGLRenderer;
  try {
    abort(signal);
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
    });
  } catch (error) {
    if (options.resourcePack) disposeCache(resources);
    throw error;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xf5f5f3, 1);
  const canvas = renderer.domElement;
  canvas.className = "schematic-canvas";
  canvas.setAttribute("aria-label", "投影 3D 预览，拖动旋转，滚轮缩放");
  container.prepend(canvas);
  let handle: SceneHandle | LayeredScene | null = null;
  let controls: OrbitControls | undefined,
    resize: ResizeObserver | undefined,
    disposed = false;
  let layers: LayerUpdates<number | null, LayerSelection> | undefined;
  let prefetchTimer: number | undefined;
  let prefetchGeneration = 0;
  const cancelPrefetch = () => {
    prefetchGeneration++;
    if (prefetchTimer !== undefined) window.clearTimeout(prefetchTimer);
    prefetchTimer = undefined;
  };
  const scene = new THREE.Scene(),
    camera = new THREE.OrthographicCamera();
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    renderer.setAnimationLoop(null);
    resize?.disconnect();
    controls?.dispose();
    cancelPrefetch();
    const pending = Promise.all([layers?.dispose(), handle?.dispose()]);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    if (options.resourcePack) void pending.then(() => disposeCache(resources));
    signal?.removeEventListener("abort", cleanup);
  };
  signal?.addEventListener("abort", cleanup, { once: true });
  try {
    handle =
      options.interactive === false
        ? await buildSchematicScene(schematic, resources, {
            animate: false,
            shouldCancel: () => Boolean(signal?.aborted || disposed),
            onProgress(stage, done, total) {
              const labels = {
                parse: "解析方块模型",
                light: "计算光照",
                build: "构建完整结构",
                optimize: "合并可见表面",
              };
              onProgress(
                `${labels[stage.name]} ${Math.round((done / Math.max(1, total)) * 100)}%`,
              );
            },
          })
        : await buildLayeredScene(schematic, resources, {
            renderer,
            animate: true,
            shouldCancel: () => Boolean(signal?.aborted || disposed),
            onProgress,
          });
    if (!handle || disposed || signal?.aborted) {
      await handle?.dispose();
      handle = null;
      throw new DOMException("渲染已取消", "AbortError");
    }
    scene.add(handle.group);
    const fullBounds = handle.bounds.clone();
    const readyMessage = () =>
      onProgress(
        `${(handle instanceof LayeredScene ? handle.visibleBlocks : handle!.blockPalette.length).toLocaleString("zh-CN")} 方块 · 拖动旋转 · 滚轮缩放 · 右键平移`,
      );
    if (handle instanceof LayeredScene) {
      const layered = handle;
      layers = new LayerUpdates(
        (y, cancelled) => layered.prepareLayer(y, cancelled),
        (selection, y) => {
          layered.show(selection);
          renderer.render(scene, camera);
          readyMessage();
          cancelPrefetch();
          if (y === null) return;
          const generation = prefetchGeneration;
          prefetchTimer = window.setTimeout(async () => {
            const cancelled = () =>
              disposed || generation !== prefetchGeneration;
            for (const nextY of [y + 1, y - 1]) {
              if (cancelled()) return;
              try {
                const next = await layered.prepareLayer(nextY, cancelled);
                if (next) layered.release(next);
              } catch {
                /* A direct request will report any load error. */
              }
            }
          }, 120);
        },
        (selection) => layered.release(selection),
        0,
      );
    }
    const dimensions = () => ({
      width: Math.max(container.clientWidth, 320),
      height: Math.max(container.clientHeight, 240),
    });
    const reset = () => {
      const { width, height } = dimensions();
      renderer.setSize(width, height, false);
      const target = fitCamera(camera, fullBounds, width / height);
      controls?.target.copy(target);
      controls?.update();
      handle!.sortTranslucent(camera);
      renderer.render(scene, camera);
    };
    if (options.interactive !== false) {
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.screenSpacePanning = true;
      controls.minZoom = 0.1;
      controls.maxZoom = 80;
      // The scene's translucent sorter already runs on camera movement. Force
      // sorting only for reset/capture, not on every damping frame.
    }
    reset();
    resize = new ResizeObserver(() => {
      const { width, height } = dimensions(),
        halfHeight = (camera.top - camera.bottom) / 2,
        cx = (camera.right + camera.left) / 2;
      camera.left = cx - (halfHeight * width) / height;
      camera.right = cx + (halfHeight * width) / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    });
    resize.observe(container);
    if (options.interactive !== false)
      renderer.setAnimationLoop(() => {
        if (document.hidden || !container.isConnected || disposed) return;
        controls?.update();
        renderer.render(scene, camera);
      });
    readyMessage();
    return {
      schematic,
      reset,
      dispose: cleanup,
      setLayer(y) {
        if (disposed) return Promise.resolve();
        if (!layers) return Promise.reject(new Error("静态预览不支持分层"));
        cancelPrefetch();
        onProgress("正在载入分层…");
        return layers!.set(y).catch((error) => {
          if (!disposed) onProgress(`分层更新失败：${error.message}`);
          throw error;
        });
      },
      capture: async () => {
        await layers?.settled();
        return new Promise((resolve, reject) => {
          if (disposed) return reject(new Error("预览已关闭"));
          handle!.sortTranslucent(camera);
          renderer.render(scene, camera);
          canvas.toBlob(
            (blob) =>
              blob ? resolve(blob) : reject(new Error("无法导出预览图")),
            "image/png",
          );
        });
      },
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// Card previews are rendered serially and cached locally. They contain exactly
// the same geometry as the interactive view and never flatten the structure.
let queue: Promise<unknown> = Promise.resolve();
export function renderThumbnail(
  container: HTMLElement,
  item: CatalogItem,
): Promise<Blob> {
  const task = queue
    .catch(() => {})
    .then(async () => {
      if (!container.isConnected)
        throw new DOMException("卡片已离开页面", "AbortError");
      const { sha1 } = await minecraftMetadata();
      const cacheKey = new Request(
        `${location.origin}/__preview/v3/${sha1}/${item.sha256}`,
      );
      const cache = await caches
        .open("tongcraft-schematic-previews-v3")
        .catch(() => null);
      const cached = await cache?.match(cacheKey);
      if (cached) return cached.blob();
      const viewer = await renderSchematic(
        container,
        await loadSchematic(item),
        { interactive: false },
      );
      try {
        const blob = await viewer.capture();
        if (cache) {
          await cache
            .put(
              cacheKey,
              new Response(blob, { headers: { "Content-Type": "image/png" } }),
            )
            .catch(() => {});
          const keys = await cache.keys();
          for (const key of keys.slice(0, Math.max(0, keys.length - 48)))
            await cache.delete(key);
        }
        return blob;
      } finally {
        viewer.dispose();
      }
    });
  queue = task;
  return task;
}
