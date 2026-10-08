# Public API

Base URL: `https://library.weiuou.top`. All API responses are JSON unless an endpoint explicitly returns a `.litematic` file. Errors use `{ "error": "message" }` and an appropriate HTTP status.

| Method   | Path                                 | Description                                                             |
| -------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `GET`    | `/api/health`                        | `{ ok: true, protocol: 1 }`                                             |
| `GET`    | `/api/items?q=&tag=&page=1&limit=24` | Public catalog, newest first; `limit` is 1–24                           |
| `GET`    | `/api/items/{id}`                    | Public metadata for one item                                            |
| `GET`    | `/api/items/{id}/file`               | Original file, with `X-Content-SHA256` for integrity checks             |
| `GET`    | `/api/session`                       | Current website member or `null`                                        |
| `GET`    | `/api/usage`                         | Admin-only R2 storage and daily operation counters                      |
| `POST`   | `/api/session/exchange`              | Redeem `{ "ticket": "..." }` from Sync; sets HttpOnly cookie            |
| `DELETE` | `/api/session`                       | Log out and clear website cookie                                        |
| `POST`   | `/api/items`                         | Member upload as multipart form: `file`, `title`, `description`, `tags` |
| `DELETE` | `/api/items/{id}`                    | Uploader or Sync admin removes an item                                  |

Mutating browser requests require a same-origin `Origin` header. Website sessions last one hour. The member login ticket comes from the Sync service's authenticated `POST /library/ticket` and is redeemed by the Worker through `POST /library/redeem`; tickets are one use and expire after five minutes.

An item includes `id`, `owner`, `title`, `description`, `tags`, `sha256`, `size`, `blocks`, `regions`, `createdAt`, and `downloadUrl`. `blocks` counts non-air blocks across the file's regions. The detail endpoint also includes `materials`, an array of `{ id, count }` entries counted from non-air block states. The website displays Chinese block names from the pinned Minecraft language assets, retains IDs for reference, and includes both names and IDs in CSV exports. Unknown IDs remain visible with an unlisted-name label. The browser downloads and verifies the original file to render its exact block positions and states with Minecraft models and textures; thumbnails use the same geometry. The mod verifies the SHA-256 before saving files to the player's local `schematics` directory.
