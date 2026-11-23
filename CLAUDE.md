# Monexa Auth: agent guide

Fastify 5 backend on `@mono/server-kit` (read its README for the plugin options). ESM, TypeScript (NodeNext), Node 24, pnpm 10.33.0. Postgres via Drizzle. This is `monexa-auth`, the central OIDC provider for Monexa apps (copied from `monexa-api-template`; the template text below still applies where it mentions features, env or `examples`). See `README.md` for setup.

## Commands

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `pnpm test:coverage`  | Vitest with PGlite (no Docker). **80%** enforced     |
| `pnpm typecheck`      | `tsc --noEmit`                                       |
| `pnpm lint`           | Biome                                                |
| `pnpm db:generate`    | New migration from `src/db/schema/`                  |
| `pnpm openapi`        | Regenerate `openapi/openapi.json` (a test checks it) |
| `pnpm auth:bootstrap` | First-run admin, admin app, org (idempotent)         |
| `pnpm auth:cleanup`   | Delete expired `oidc_store` rows (run from cron)     |

## Rules

- New features follow `src/admin/platform/*` (the examples feature was removed): routes → service → repository.
  - Services never import Fastify. Repositories hold queries only. A test enforces this.
- Every org-scoped admin route acts on `request.admin.orgId` only, never on an org id from the body or path.
- Org admins can't act on themselves or on platform admins. `platform:*` permissions are never granted through roles.
- Never log secrets (passwords, hashes, tokens, client secrets, codes) or identifiers of unknown users.
- `oidc-provider` is pinned to `~9.15.1`: the org id is persisted through `Grant.IN_PAYLOAD`, an internal. Re-check `src/oidc/provider.ts` and the org tests before bumping it.
- Expired `oidc_store` rows are removed from cron only, never from request handling: `pnpm auth:cleanup` / `node dist/cli/cleanup.js` (Docker), or Vercel Cron calling `GET /api/cron/cleanup` with `CRON_SECRET`.
- Every route declares Zod request **and** response schemas.
- Handlers call `reply.ok(...)` and never `return reply.ok(...)` (it's a type error with a response schema). Expected failures throw the kit's `AppError` with Indonesian copy.
- Never re-implement what the kit owns:
  - envelope;
  - status mapping (401/403/422/503);
  - auth;
  - RBAC.

  Guard routes with `app.requirePermission(PERMISSIONS.x)`, adding the string to `src/permissions.ts` first.
- No in-memory state across requests and no timers or background jobs. The same code runs on Vercel Functions.
- Migrations never run at boot. Never edit `src/db/migrations` by hand.
- Private registry auth lives only in `scripts/write-npmrc.sh`. Never hard-code GitLab project IDs or tokens.
- Keep the `// #region handbook:*` markers. The Monexa handbook embeds them.
