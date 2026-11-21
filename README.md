# Monexa Auth

The central OIDC provider for Monexa apps: [`oidc-provider`](https://github.com/panva/node-oidc-provider) on Fastify 5 and [`@mono/server-kit`](../mono-server-kit), with PostgreSQL + Drizzle, Zod schemas and Vitest (coverage threshold **80%**). Copied from `monexa-api-template`.

It issues RS256 JWT access tokens (`aud` = client id, plus `client_id`, `org_id`, `org_name`, `permissions`) and refresh tokens, serves the admin API under `/api/admin/*` and `/api/me/orgs`, and the sign-in and `/account/password` pages. Google login is deferred and not implemented.

## Local stack

Registry access is the same as in the FE template:
- Set `export GITLAB_PACKAGE_GROUP_ID="123456"` in your shell profile.
- Create a personal GitLab token with `read_package_registry`.
  - On macOS, save it in Keychain Access as a password item named `monexa-gitlab-npm`, with the username from `id -un` as the account.
  - Elsewhere, provide it as `GITLAB_NPM_TOKEN`.
- `pnpm registry:run <args>` runs pnpm with a temporary npm config that is deleted when pnpm exits. Never commit a token or a generated `.npmrc`.

```bash
pnpm registry:run install
docker compose up -d        # Postgres only, :5432
cp .env.example .env        # dev values; set BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD
pnpm db:migrate
pnpm auth:bootstrap         # prints the admin app's client secret once
pnpm dev                    # http://localhost:9000, OIDC under /oidc
```

`pnpm auth:bootstrap` is idempotent. It creates the platform admin, the sso-only admin app (`ADMIN_CLIENT_ID`, redirect URIs from `BOOTSTRAP_ADMIN_REDIRECT_URIS`, default `http://localhost:3001/auth/callback`), its permission catalog (`platform:all`, `org.member:manage`, `org.role:assign`, `org.activity:view`), the role "Org Admin" (the three `org.*`) and the org "Monexa" (slug `monexa`) with the admin app enabled and the admin as a member. The password goes through the shared password policy and is never logged. A repeat run keeps existing rows (the admin user is made an active platform admin again) and prints no secret, so save it the first time. The bootstrap admin gets no org role: `platform:all` satisfies every admin permission, so they can manage members and assign the "Org Admin" role in any org they switch into.

**Admin UI backend:** this service is also the admin UI's backend. Put the bootstrap secret in **this service's** `ADMIN_CLIENT_SECRET` (plus `ADMIN_REDIRECT_URIS`, `ADMIN_POST_LOGOUT_REDIRECT_URI`) and restart. It then serves the kit's `/v1/auth/*` for the admin app; without the secret those routes are simply absent. The admin UI's own `.env` needs only `API_BASE_URL=<this service's origin>`, `AUTH_MODE=sso` and `AUTH_PORTAL_URL=<the same origin>`.

**Lost admin app secret:** the admin UI cannot rotate it once it no longer has it (signing in to the admin UI needs that secret). Either re-run bootstrap with `BOOTSTRAP_ROTATE_ADMIN_SECRET=true`, which issues and prints a new secret, or have another platform admin who still holds a valid admin-app access token call `POST /api/admin/platform/apps/{id}/rotate-secret`. Then update this service's `ADMIN_CLIENT_SECRET`.

## Pointing an app template at it

In the app's `.env` (API and FE templates):

```
AUTH_MODE=sso            # or credentials
AUTH_ISSUER=http://localhost:9000/oidc
AUTH_CLIENT_ID=<client id>
AUTH_CLIENT_SECRET=<client secret>
AUTH_REDIRECT_URIS=<the FE callback URL, registered on the app>
```

The client id and secret come from the admin UI (shown once when you create the app or rotate its secret) or, for the admin app itself, from `pnpm auth:bootstrap`. `credentials` apps need the `password` grant on the app, `sso` apps the `authorization_code` grant. The refresh grant is implied.

## Creating apps and roles

As a platform admin, in the admin UI (or the API, see `openapi/openapi.json`):
1. **Create the app:** client id, redirect URIs, grants, access TTL and refresh TTL. The client secret is returned once.
2. **Fill its permission catalog:** strings like `invoice:read` or `org.member:manage`. Roles can only use catalog permissions, and `platform:*` is never granted through roles.
3. **Create roles** for the app from catalog permissions.
4. **Brand the org (optional):** upload its login logo (PNG, JPEG or WebP, ≤ 512 KB) on the Organizations page, or let its org admins do it (`org.branding:manage`, part of "Org Admin"). Apps that set `AUTH_ORG_HINT` to the org's slug show it on the login page. After upgrading, re-run `pnpm auth:bootstrap` once so existing installs get the new permission.
5. **Enable the app for an org**, add members to the org and assign them roles. Org admins (a role holding the `org.*` permissions) manage members, role assignments and the activity log of their own org only. Platform admins can do the same in any org they switch into (`platform:all` satisfies every admin permission); unlike org admins they may also act on other platform admins and reset multi-org users' passwords. Nobody can change their own roles, membership or password through the admin API. The admin app itself cannot be deactivated.

## Org selection and switching

A user may belong to several orgs; a token is always for one org.
- **At sign-in:** the org is the `org_hint` authorize parameter if eligible, else the last one used, else the first eligible (by name). A hint the user can't use is ignored: the user picks from the org picker, or goes straight in when only one org is eligible.
- **Listing:** `GET /api/me/orgs` (bearer token) returns the orgs the user may enter for the calling app.
- **Switching:** POST to `/oidc/token` with `grant_type=urn:monexa:params:oauth:grant-type:org-switch`, the current `refresh_token` and `org_id`. The response carries a new access and refresh token for that org; every earlier token of the grant is revoked and the grant itself moves to the new org (so a central logout still ends it). The request authenticates as the same client. An org the user can't enter fails with `org_not_eligible`.

## Error reasons

Token endpoint failures carry exactly one of these in `error_description`:

| Reason                     | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `invalid_credentials`      | Bad credentials. Unknown, inactive and locked users look the same on purpose     |
| `no_app_access`            | Valid user, but no org with this app enabled                                     |
| `password_change_required` | The password is temporary; send the user to `/account/password`                  |
| `google_required`          | Reserved for Google-only apps. Google login is deferred, so it is not issued yet |
| `org_not_eligible`         | The requested org is not available to this user for this app                     |

`/account/password` is a standalone page (no app session needed) where a user replaces a temporary password; it enforces the shared policy and clears `must_change_password`. Changing a password there, or at the forced change during sign-in, ends every other grant and session of the user (the sign-in in progress still completes).

## Sessions, revocation and keys

- **Session cap:** a rotated refresh token gets a full app refresh TTL again. The absolute cap is the grant TTL, `max(14 days, refresh TTL)`.
- **Refresh and org-switch** recompute permissions from the database.
- **Deactivating a user, resetting a password (org or platform API) or changing your own password** revokes all of the user's grants. **Removing or deactivating a membership** revokes the grants of that org. **Role changes do not revoke:** they apply at the next refresh, which recomputes permissions. Access tokens are not revocable and live out their TTL (default 10 minutes).
- **Central logout and account changes:** RP-initiated logout ends the grants of every app in the browser session. When a different account signs in on the same browser, the previous account's grants for every app in that session are revoked.
- **Admin and `/api/me` tokens** must be access tokens (`typ` `at+jwt`); ID tokens are refused.
- **The admin API** re-checks the user, platform-admin flag and membership on every request, so it reacts immediately.
- **Secrets:** `OIDC_SIGNING_KEY` (RSA PEM, single line with `\n`), `CLIENT_SECRET_KEY` (base64 of 32 bytes; encrypts client secrets at rest) and `OIDC_COOKIE_KEYS` are secrets. The committed `.env.example` values are throwaway dev keys. There is **no key rotation yet**: changing `CLIENT_SECRET_KEY` makes every stored client secret unreadable, and changing `OIDC_SIGNING_KEY` invalidates issued tokens.
- Never log passwords, hashes, tokens, client secrets or codes.

## Environment

| Variable                                   | Default                               | Notes                                                                |
| ------------------------------------------ | ------------------------------------- | -------------------------------------------------------------------- |
| `PORT`                                     | `8080` (`.env.example`: `9000`)       |                                                                      |
| `LOG_LEVEL`                                | `info`                                |                                                                      |
| `DATABASE_URL`                             | required                              | On Vercel, use a pooler (PgBouncer transaction mode)                 |
| `DB_POOL_MAX`                              | `10`                                  | Use 1-3 on Vercel                                                    |
| `OIDC_ISSUER`                              | required                              | Public base URL; clients use `<OIDC_ISSUER>/oidc` as their issuer    |
| `OIDC_SIGNING_KEY`                         | required                              | RSA private key PEM                                                  |
| `OIDC_COOKIE_KEYS`                         | required                              | Comma-separated; the first signs, all verify                         |
| `CLIENT_SECRET_KEY`                        | required                              | base64 of 32 bytes                                                   |
| `ADMIN_CLIENT_ID`                          | `monexa-admin`                        | The admin app; its platform admins get `platform:all`                |
| `LOCKOUT_MAX_FAILURES` / `LOCKOUT_MINUTES` | `5` / `15`                            | Password lockout                                                     |
| `CORS_ORIGINS`                             | -                                     | Comma-separated. Empty means no CORS                                 |
| `RATE_LIMIT_MAX` / `LOGIN_RATE_LIMIT_MAX`  | `300` / `10`                          | Per minute. `/health` and `/ready` are never limited                 |
| `TRUST_PROXY`                              | `false`                               | `true` behind a proxy that sets `X-Forwarded-For`                    |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD`      | -                                     | Only for `pnpm auth:bootstrap`                                       |
| `BOOTSTRAP_ADMIN_REDIRECT_URIS`            | `http://localhost:3001/auth/callback` | Comma-separated; only for `pnpm auth:bootstrap`                      |
| `BOOTSTRAP_ROTATE_ADMIN_SECRET`            | `false`                               | `true` issues a new admin app secret; only for `pnpm auth:bootstrap` |

An empty value counts as unset. A bad env fails at boot, and the error names the keys but never their values.

## Deployment

**Docker is recommended** (long-lived process, steady traffic):

```bash
docker build --secret id=gitlab_npm_token,env=GITLAB_NPM_TOKEN --build-arg GITLAB_PACKAGE_GROUP_ID=... -t monexa-auth .
```

Run migrations as a release step before rollout: `node dist/db/migrate.js` in the image, or the **Migrate** GitHub workflow. Run `node dist/cli/bootstrap.js` in the image once against the new database (with the `BOOTSTRAP_*` env set; `pnpm auth:bootstrap` is the dev equivalent). Migrations never run at boot.

A Vercel entry (`api/index.ts`, `vercel.json`) is kept from the template and works, but it is not the recommended home for an identity provider. If you use it, set `GITLAB_NPM_TOKEN` and `GITLAB_PACKAGE_GROUP_ID`, a pooled `DATABASE_URL` and `DB_POOL_MAX` of 1-3. Production builds migrate through `scripts/vercel-build.sh`; previews skip migrations unless `MIGRATE_ON_PREVIEW=true`, and `MIGRATION_DATABASE_URL` can hold a direct connection.

### Expired-row cleanup

`oidc_store` rows (sessions, interactions, codes, tokens) are not deleted when they expire. Run the cleanup CLI from cron, for example hourly (`node dist/cli/cleanup.js` in the Docker image; `pnpm auth:cleanup` in a dev checkout):

```
0 * * * * docker run --rm --env-file /etc/monexa-auth.env monexa-auth node dist/cli/cleanup.js
```

It deletes rows with `expires_at < now()` and prints the count. It never runs inside request handling. The plain SQL `DELETE FROM oidc_store WHERE expires_at < now();` is equivalent.

## Adding an admin feature

Follow `src/admin/platform/*` (`routes.ts`, `service.ts`, `repository.ts`; org-scoped ones are under `src/admin/org/*`): routes validate and call the service with `reply.ok(...)`, services hold logic and write one `activity_log` row in the same transaction, repositories hold queries. Then run `pnpm openapi`; a test fails while `openapi/openapi.json` is stale.

## Scripts

`registry:run`, `dev`, `build`, `start`, `db:generate`, `db:migrate`, `db:studio`, `auth:bootstrap`, `auth:cleanup`, `openapi`, `lint`, `typecheck`, `test:coverage`.
