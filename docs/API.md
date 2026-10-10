# Public API

Base URL: `https://library.weiuou.top`. Responses are JSON except for original `.litematic` files and PNG previews. Errors use `{ "error": "message" }` and an appropriate HTTP status.

| Method   | Path                                 | Description                                                                                     |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GET`    | `/api/health`                        | `{ ok: true, protocol: 1 }`                                                                     |
| `GET`    | `/api/items?q=&tag=&page=1&limit=24` | Public catalog, newest first; `limit` is 1–24                                                   |
| `GET`    | `/api/items/{id}`                    | Public metadata for one item                                                                    |
| `GET`    | `/api/items/{id}/file`               | Original file, with `X-Content-SHA256` for integrity checks                                     |
| `GET`    | `/api/items/{id}/preview`            | Saved PNG render, publicly cacheable for 24 hours; 404 for older items without a preview        |
| `GET`    | `/api/session`                       | Current website member or `null`                                                                |
| `GET`    | `/api/usage`                         | Admin-only R2 storage and daily operation counters                                              |
| `POST`   | `/api/session/exchange`              | Redeem `{ "ticket": "..." }` from Sync; sets HttpOnly cookie                                    |
| `DELETE` | `/api/session`                       | Log out and clear website cookie                                                                |
| `POST`   | `/api/items`                         | Member upload as multipart form: `file`, `title`, `description`, `tags`, optional `preview` PNG |
| `DELETE` | `/api/items/{id}`                    | Uploader or Sync admin removes an item                                                          |

Mutating browser requests require a same-origin `Origin` header. Website sessions last one hour. The member login ticket comes from the Sync service's authenticated `POST /library/ticket` and is redeemed by the Worker through `POST /library/redeem`; tickets are one use and expire after five minutes.

An item includes `id`, `owner`, `title`, `description`, `tags`, `sha256`, `size`, `blocks`, `regions`, `createdAt`, and `downloadUrl`, plus `previewUrl` when a saved image exists. `blocks` counts non-air blocks across the file's regions. The detail endpoint also includes `materials`, an array of `{ id, count }` entries counted from non-air block states. The website displays Chinese block names from the pinned Minecraft language assets, retains IDs for reference, and includes both names and IDs in CSV exports. Unknown IDs remain visible with an unlisted-name label.

Website uploads render a 768 × 480 PNG from the original block geometry with default Minecraft models and textures before submitting the form. The Worker accepts static PNGs up to 512 KiB with dimensions up to 1024 × 1024, stores them alongside the schematic in R2, and includes their size in storage accounting. Each upload with an image uses two R2 writes. Both objects are cleaned up on upload failure or deletion. Older API clients may omit the image; those entries display a placeholder. Catalogue and detail browsing load saved images directly; the full file and interactive renderer are loaded only when the visitor chooses 3D rotation/layers. Preview cache hits do not consume another R2 read, and removed items return 404 even if an edge cache entry remains. The mod also caches PNGs on disk and verifies the schematic SHA-256 before saving it to the player's local `schematics` directory.
