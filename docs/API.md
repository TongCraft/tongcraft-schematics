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

An item includes `id`, `owner`, `title`, `description`, `tags`, `sha256`, `size`, `blocks`, `regions`, `createdAt`, and `downloadUrl`. The mod verifies the SHA-256 before saving files to the player's local `schematics` directory.
