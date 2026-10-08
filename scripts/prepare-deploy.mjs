import { readFile, mkdir, writeFile } from "node:fs/promises";

const {
  D1_DATABASE_ID,
  SYNC_API_URL,
  CLOUDFLARE_ACCOUNT_ID,
  ALLOW_PUBLIC_PREVIEW,
} = process.env;
if (!/^[0-9a-f-]{36}$/i.test(D1_DATABASE_ID || ""))
  throw new Error("Set D1_DATABASE_ID to the provisioned database UUID");
if (!CLOUDFLARE_ACCOUNT_ID) throw new Error("Set CLOUDFLARE_ACCOUNT_ID");
if (!SYNC_API_URL && ALLOW_PUBLIC_PREVIEW !== "true")
  throw new Error(
    "Set SYNC_API_URL, or ALLOW_PUBLIC_PREVIEW=true for a read-only preview",
  );
const sync = SYNC_API_URL ? new URL(SYNC_API_URL) : null;
if (sync && sync.protocol !== "https:")
  throw new Error("SYNC_API_URL must be HTTPS");
const config = JSON.parse(await readFile("wrangler.json", "utf8"));
config.main = "../src/index.ts";
config.assets.directory = "../web";
config.d1_databases[0].migrations_dir = "../migrations";
config.d1_databases[0].database_id = D1_DATABASE_ID;
config.vars = sync ? { SYNC_API_URL: sync.origin } : {};
await mkdir(".wrangler", { recursive: true });
await writeFile(
  ".wrangler/deploy.json",
  JSON.stringify(config, null, 2) + "\n",
);
console.log("Prepared Wrangler deployment configuration");
