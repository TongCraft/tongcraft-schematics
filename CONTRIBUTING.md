# Contributing

Issues and pull requests are welcome. Describe the behavior, how to reproduce it, and the expected result. Keep unrelated changes in separate pull requests.

## Development

Use Node.js 24, run `npm ci`, `npm run db:local`, and `npm run dev`. Before a pull request, run `npm run check` and `npm audit --audit-level=high`.

Do not commit Cloudflare credentials, `.dev.vars`, `.env`, or player upload files. The upload API accepts only validated `.litematic` files; keep limits and server-side validation when changing it.

The web interface is written in plain HTML, CSS, and JavaScript; the Worker is TypeScript. Prefer clear dependencies and small, reviewable changes.
