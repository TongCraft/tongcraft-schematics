import { MAX_FILE_BYTES, SchematicError, validateLitematic } from "./schematic";
import { MAX_PREVIEW_BYTES, validatePreview } from "./preview";

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  SYNC_API_URL?: string;
}

interface Member {
  uuid: string;
  name: string;
  role: "admin" | "member";
}
interface ItemRow {
  id: string;
  owner_uuid: string;
  owner_name: string;
  title: string;
  description: string;
  tags: string;
  hash: string;
  file_size: number;
  block_count: number;
  region_count: number;
  created_at: number;
  materials?: string | null;
  preview_size: number;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_COOKIE = "tc_library_session";
const PAGE_SIZE = 24;
// Each dimension stays well below the account-wide R2 Standard free allowance.
const STORAGE_LIMIT = 5_000_000_000;
const DAILY_PUT_LIMIT = 500;
const DAILY_GET_LIMIT = 10_000;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function reserveStorage(env: Env, bytes: number): Promise<void> {
  const result = await env.DB.prepare(
    "UPDATE storage_budget SET used_bytes=used_bytes+? WHERE id=1 AND used_bytes+?<=?",
  )
    .bind(bytes, bytes, STORAGE_LIMIT)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(507, "素材库免费存储额度已满，暂时无法上传");
}

async function releaseStorage(env: Env, bytes: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE storage_budget SET used_bytes=used_bytes-? WHERE id=1",
  )
    .bind(bytes)
    .run();
}

async function reserveR2Operation(
  env: Env,
  kind: "put" | "get",
): Promise<void> {
  const puts = kind === "put" ? 1 : 0;
  const gets = kind === "get" ? 1 : 0;
  const result = await env.DB.prepare(
    "INSERT INTO r2_daily_usage(day,puts,gets) VALUES(?,?,?) " +
      "ON CONFLICT(day) DO UPDATE SET puts=puts+excluded.puts, gets=gets+excluded.gets " +
      "WHERE puts+excluded.puts<=? AND gets+excluded.gets<=?",
  )
    .bind(today(), puts, gets, DAILY_PUT_LIMIT, DAILY_GET_LIMIT)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(
      429,
      kind === "put"
        ? "今日上传额度已用尽，请明天再试"
        : "今日下载额度已用尽，请明天再试",
    );
}

async function usage(request: Request, env: Env): Promise<Response> {
  const member = await requireSession(request, env);
  if (member.role !== "admin") throw new ApiError(403, "仅管理员可查看用量");
  const storage = await env.DB.prepare(
    "SELECT used_bytes FROM storage_budget WHERE id=1",
  ).first<{ used_bytes: number }>();
  const daily = await env.DB.prepare(
    "SELECT puts,gets FROM r2_daily_usage WHERE day=?",
  )
    .bind(today())
    .first<{ puts: number; gets: number }>();
  return json({
    storageBytes: storage?.used_bytes ?? 0,
    storageLimit: STORAGE_LIMIT,
    today: today(),
    puts: daily?.puts ?? 0,
    putLimit: DAILY_PUT_LIMIT,
    gets: daily?.gets ?? 0,
    getLimit: DAILY_GET_LIMIT,
  });
}

function json(
  data: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function assertOrigin(request: Request): void {
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    throw new ApiError(403, "请求来源无效");
}

function field(value: unknown, label: string, max: number): string {
  if (typeof value !== "string") throw new ApiError(400, `${label}无效`);
  const clean = value.trim();
  if (!clean || clean.length > max || /[\x00-\x1f\x7f]/.test(clean))
    throw new ApiError(400, `${label}长度或内容无效`);
  return clean;
}

function tags(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 200)
    throw new ApiError(400, "标签无效");
  const result = [
    ...new Set(
      value
        .split(/[，,]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
  if (
    result.length > 5 ||
    result.some((tag) => tag.length > 24 || /[\x00-\x1f\x7f]/.test(tag))
  )
    throw new ApiError(400, "最多填写 5 个标签，每个不超过 24 字");
  return result;
}

function item(row: ItemRow, includeMaterials = false) {
  return {
    id: row.id,
    owner: { uuid: row.owner_uuid, name: row.owner_name },
    title: row.title,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    sha256: row.hash,
    size: row.file_size,
    blocks: row.block_count,
    regions: row.region_count,
    createdAt: row.created_at,
    downloadUrl: `/api/items/${row.id}/file`,
    ...(row.preview_size > 0
      ? { previewUrl: `/api/items/${row.id}/preview` }
      : {}),
    ...(includeMaterials
      ? {
          materials: JSON.parse(row.materials ?? "[]") as {
            id: string;
            count: number;
          }[],
        }
      : {}),
  };
}

async function digest(bytes: Uint8Array | string): Promise<string> {
  const input =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);
  return [...new Uint8Array(hash)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function cookieValue(request: Request): string | null {
  const match = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)tc_library_session=([A-Za-z0-9_-]{43})(?:;|$)/);
  return match?.[1] ?? null;
}

async function session(request: Request, env: Env): Promise<Member | null> {
  const token = cookieValue(request);
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT uuid, name, role FROM web_sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await digest(token), Date.now())
    .first<Member>();
  return row?.role === "admin" || row?.role === "member" ? row : null;
}

async function requireSession(request: Request, env: Env): Promise<Member> {
  const member = await session(request, env);
  if (!member) throw new ApiError(401, "请先从 TongCraft Sync 模组登录");
  return member;
}

async function exchangeTicket(request: Request, env: Env): Promise<Response> {
  assertOrigin(request);
  if (!env.SYNC_API_URL) throw new ApiError(503, "Sync 登录服务尚未配置");
  const input = (await request.json().catch(() => null)) as {
    ticket?: unknown;
  } | null;
  const ticket = field(input?.ticket, "登录凭证", 128);
  const base = new URL(env.SYNC_API_URL);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(base.hostname)
  )
    throw new ApiError(503, "Sync 登录服务地址无效");
  const upstream = await fetch(new URL("/library/redeem", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new ApiError(503, "暂时无法连接 Sync 登录服务");
  });
  if (!upstream.ok)
    throw new ApiError(401, "登录链接已过期或已使用，请从模组重新获取");
  const profile = (await upstream.json()) as Partial<Member>;
  if (
    !/^[a-f0-9]{32}$/.test(profile.uuid ?? "") ||
    typeof profile.name !== "string" ||
    profile.name.length > 16 ||
    !["admin", "member"].includes(profile.role ?? "")
  )
    throw new ApiError(503, "Sync 登录服务返回了无效身份");
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO web_sessions(token_hash,uuid,name,role,expires_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      await digest(token),
      profile.uuid,
      profile.name,
      profile.role,
      Date.now() + 60 * 60 * 1000,
    )
    .run();
  return json({ member: profile }, 200, {
    "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
  });
}

async function listItems(url: URL, env: Env): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim();
  const tag = (url.searchParams.get("tag") ?? "").trim();
  const page = Number(url.searchParams.get("page") ?? "1");
  const limit = Number(url.searchParams.get("limit") ?? PAGE_SIZE);
  if (
    q.length > 80 ||
    tag.length > 24 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PAGE_SIZE
  )
    throw new ApiError(400, "搜索条件无效");
  const conditions = ["deleted_at IS NULL"];
  const values: unknown[] = [];
  if (q) {
    conditions.push(
      "(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR owner_name LIKE ? ESCAPE '\\')",
    );
    const pattern = `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    values.push(pattern, pattern, pattern);
  }
  if (tag) {
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(items.tags) WHERE json_each.value=?)",
    );
    values.push(tag);
  }
  const where = conditions.join(" AND ");
  const total = await env.DB.prepare(
    `SELECT count(*) AS n FROM items WHERE ${where}`,
  )
    .bind(...values)
    .first<{ n: number }>();
  const rows = await env.DB.prepare(
    `SELECT id,owner_uuid,owner_name,title,description,tags,hash,file_size,block_count,region_count,created_at,preview_size FROM items WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
  )
    .bind(...values, limit, (page - 1) * limit)
    .all<ItemRow>();
  return json({
    items: rows.results.map((row) => item(row)),
    page,
    pageSize: limit,
    total: total?.n ?? 0,
  });
}

async function getItem(id: string, env: Env): Promise<ItemRow> {
  const row = await env.DB.prepare(
    "SELECT id,owner_uuid,owner_name,title,description,tags,hash,file_size,block_count,region_count,created_at,materials,preview_size FROM items WHERE id=? AND deleted_at IS NULL",
  )
    .bind(id)
    .first<ItemRow>();
  if (!row) throw new ApiError(404, "找不到这份蓝图");
  return row;
}

async function upload(request: Request, env: Env): Promise<Response> {
  assertOrigin(request);
  const member = await requireSession(request, env);
  const length = Number(request.headers.get("Content-Length"));
  if (length > MAX_FILE_BYTES + MAX_PREVIEW_BYTES + 32_768)
    throw new ApiError(413, "上传文件超过 16 MiB");
  if (!request.headers.get("Content-Type")?.startsWith("multipart/form-data;"))
    throw new ApiError(415, "请使用表单上传");
  const form = await request.formData().catch(() => {
    throw new ApiError(400, "上传表单无效");
  });
  const title = field(form.get("title"), "名称", 80);
  const descriptionValue = form.get("description");
  if (
    typeof descriptionValue !== "string" ||
    descriptionValue.length > 1200 ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(descriptionValue)
  )
    throw new ApiError(400, "简介无效");
  const description = descriptionValue.trim();
  const itemTags = tags(form.get("tags") ?? "");
  const file = form.get("file");
  if (
    !(file instanceof File) ||
    !file.name.toLowerCase().endsWith(".litematic")
  )
    throw new ApiError(400, "请选择 .litematic 文件");
  if (file.size === 0 || file.size > MAX_FILE_BYTES)
    throw new ApiError(413, "蓝图须小于 16 MiB");
  const previewFile = form.get("preview");
  let preview: Uint8Array | undefined;
  if (previewFile !== null) {
    if (
      !(previewFile instanceof File) ||
      previewFile.type !== "image/png" ||
      previewFile.size > MAX_PREVIEW_BYTES
    )
      throw new ApiError(400, "预览图须为不超过 512 KiB 的 PNG");
    preview = new Uint8Array(await previewFile.arrayBuffer());
    try {
      validatePreview(preview);
    } catch (error) {
      throw new ApiError(400, (error as Error).message);
    }
  }
  const recent = await env.DB.prepare(
    "SELECT count(*) AS n FROM items WHERE owner_uuid=? AND created_at>?",
  )
    .bind(member.uuid, Date.now() - 24 * 60 * 60 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 20)
    throw new ApiError(429, "每位成员每天最多上传 20 份蓝图");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = validateLitematic(bytes);
  const hash = await digest(bytes);
  const duplicate = await env.DB.prepare(
    "SELECT id FROM items WHERE owner_uuid=? AND hash=? AND deleted_at IS NULL",
  )
    .bind(member.uuid, hash)
    .first<{ id: string }>();
  if (duplicate) throw new ApiError(409, "你已经上传过这份蓝图");
  const id = crypto.randomUUID();
  const key = `items/${id}.litematic`;
  const previewKey = `previews/${id}.png`;
  const storageBytes = bytes.byteLength + (preview?.byteLength ?? 0);
  await reserveStorage(env, storageBytes);
  let putAttempted = false;
  try {
    await reserveR2Operation(env, "put");
    putAttempted = true;
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256: hash },
    });
    if (preview) {
      await reserveR2Operation(env, "put");
      await env.FILES.put(previewKey, preview, {
        httpMetadata: { contentType: "image/png" },
        customMetadata: { schematicSha256: hash },
      });
    }
    await env.DB.prepare(
      "INSERT INTO items(id,owner_uuid,owner_name,title,description,tags,hash,file_size,block_count,region_count,created_at,materials,preview_size) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        id,
        member.uuid,
        member.name,
        title,
        description,
        JSON.stringify(itemTags),
        hash,
        bytes.byteLength,
        metadata.solidBlocks,
        metadata.regions.length,
        Date.now(),
        JSON.stringify(metadata.materials),
        preview?.byteLength ?? 0,
      )
      .run();
  } catch (error) {
    try {
      if (putAttempted) await env.FILES.delete([key, previewKey]);
      await releaseStorage(env, storageBytes);
    } catch (cleanupError) {
      console.error(
        "R2 upload cleanup failed; capacity remains reserved",
        cleanupError,
      );
    }
    throw error;
  }
  return json({ id, url: `/items/${id}` }, 201);
}

async function removeItem(
  request: Request,
  id: string,
  env: Env,
): Promise<Response> {
  assertOrigin(request);
  const member = await requireSession(request, env);
  const row = await getItem(id, env);
  if (row.owner_uuid !== member.uuid && member.role !== "admin")
    throw new ApiError(403, "只能删除自己上传的蓝图");
  const removed = await env.DB.prepare(
    "UPDATE items SET deleted_at=? WHERE id=? AND deleted_at IS NULL",
  )
    .bind(Date.now(), id)
    .run();
  if (removed.meta.changes === 1) {
    try {
      await env.FILES.delete([`items/${id}.litematic`, `previews/${id}.png`]);
      await releaseStorage(env, row.file_size + row.preview_size);
    } catch (error) {
      console.error("R2 cleanup failed; capacity remains reserved", error);
    }
  }
  return json({ ok: true });
}

async function downloadItem(row: ItemRow, env: Env): Promise<Response> {
  await reserveR2Operation(env, "get");
  const object = await env.FILES.get(`items/${row.id}.litematic`);
  if (!object) throw new ApiError(503, "蓝图文件暂时不可用");
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(row.file_size),
      "Content-Disposition": `attachment; filename="${row.id}.litematic"; filename*=UTF-8''${encodeURIComponent(row.title + ".litematic")}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Content-SHA256": row.hash,
    },
  });
}

async function downloadPreview(
  request: Request,
  row: ItemRow,
  env: Env,
): Promise<Response> {
  if (!row.preview_size) throw new ApiError(404, "这份蓝图尚未生成预览图");
  const key = new Request(request.url);
  const cache = await caches.open("tongcraft-previews-v1");
  const cached = await cache.match(key);
  if (cached) return cached;
  await reserveR2Operation(env, "get");
  const object = await env.FILES.get(`previews/${row.id}.png`);
  if (!object) throw new ApiError(503, "预览图暂时不可用");
  const response = new Response(object.body, {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(row.preview_size),
      "Cache-Control": "public, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${row.id}"`,
    },
  });
  await cache.put(key, response.clone());
  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health" && request.method === "GET")
        return json({
          ok: true,
          protocol: 1,
          loginAvailable: Boolean(env.SYNC_API_URL),
        });
      if (path === "/api/usage" && request.method === "GET")
        return await usage(request, env);
      if (path === "/api/session" && request.method === "GET")
        return json({ member: await session(request, env) });
      if (path === "/api/session" && request.method === "DELETE") {
        assertOrigin(request);
        const token = cookieValue(request);
        if (token)
          await env.DB.prepare("DELETE FROM web_sessions WHERE token_hash=?")
            .bind(await digest(token))
            .run();
        return json({ ok: true }, 200, {
          "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        });
      }
      if (path === "/api/session/exchange" && request.method === "POST")
        return await exchangeTicket(request, env);
      if (path === "/api/items" && request.method === "GET")
        return await listItems(url, env);
      if (path === "/api/items" && request.method === "POST")
        return await upload(request, env);
      const match = path.match(
        /^\/api\/items\/([a-f0-9-]{36})(?:\/(file|preview))?$/,
      );
      if (match) {
        const row = await getItem(match[1], env);
        if (match[2] === "file" && request.method === "GET")
          return await downloadItem(row, env);
        if (match[2] === "preview" && request.method === "GET")
          return await downloadPreview(request, row, env);
        if (!match[2] && request.method === "GET")
          return json({ item: item(row, true) });
        if (!match[2] && request.method === "DELETE")
          return await removeItem(request, row.id, env);
      }
      if (path.startsWith("/api/")) throw new ApiError(404, "接口不存在");
      if (
        request.method === "GET" &&
        (path === "/login" || /^\/items\/[a-f0-9-]{36}$/.test(path))
      )
        return env.ASSETS.fetch(
          new Request(new URL("/", request.url), request),
        );
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof ApiError)
        return json({ error: error.message }, error.status);
      if (error instanceof SchematicError)
        return json({ error: error.message }, 400);
      console.error("Request failed", error);
      return json({ error: "服务暂时不可用" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
