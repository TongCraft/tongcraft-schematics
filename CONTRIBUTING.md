# Contributing

Issues and pull requests are welcome. Describe the behavior, how to reproduce it, and the expected result. Keep unrelated changes in separate pull requests.

## Development

Use Node.js 24, run `npm ci`, `npm run db:local`, and `npm run dev`. Before a pull request, run `npm run check` and `npm audit --audit-level=high`.

Do not commit Cloudflare credentials, `.dev.vars`, `.env`, or player upload files. The upload API accepts only validated `.litematic` files; keep limits and server-side validation when changing it.

The web interface uses HTML, CSS, and JavaScript; the 3D renderer (`client/renderSchematic.ts`), shared Litematica parser, and Worker use TypeScript. `npm run build` bundles the renderer and downloads checksum-pinned Minecraft resources into ignored build directories. Prefer clear dependencies and small, reviewable changes. Never replace blockstates with simplified shapes or resample the schematic for previews.
