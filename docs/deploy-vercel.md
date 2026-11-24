# Deploying monexa-auth and the admin UI on Vercel

Two Vercel projects, one Postgres database:

| Project             | Repo                         | Domain                  | Notes                                                                |
| ------------------- | ---------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `monexa-auth`       | `mngroups/monexa-auth`       | `auth.mngroup.id`       | OIDC issuer `https://auth.mngroup.id/oidc`, sign-in pages, admin API |
| `monexa-auth-admin` | `mngroups/monexa-auth-admin` | `auth-admin.mngroup.id` | Next.js admin UI; talks to monexa-auth server-side only              |

> **The issuer is permanent.** `OIDC_ISSUER` ends up in every token and in every app's `AUTH_ISSUER`. Changing it later invalidates all sessions and needs every app reconfigured. Pick the domain once.

## Fast path (scripts)

Everything below is automated from this repo. The non-secret settings (team, region, domains, repos, org hint) live in `deploy/vercel.config.json`. Secrets are never printed or written to disk: steps that need production env run under `vercel env run` from an empty directory, and values reach Vercel on stdin.

| Command                                  | What it does                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm deploy:setup [--dry-run]`          | Idempotent. It creates or repairs both projects (GitHub link, preset, Node 24) and creates the Neon database if missing. It syncs config env (`--no-sensitive`), generates the four keys **only if missing**, asks for `GITLAB_NPM_TOKEN` (hidden) when absent, attaches the domains, and lists missing DNS records. A variable stored with the wrong type is reported, never deleted. |
| `pnpm deploy:release [auth\|admin\|all]` | Deploys `main` from GitHub, waits for READY, then runs the smoke checks: health, ready, discovery, the admin sign-in redirect chain, and cron without and with a token.                                                                                                                                                                                                                |
| `pnpm deploy:bootstrap [--rotate]`       | First run only. It asks for the admin email and password (hidden) and runs the bootstrap against production. It checks the new admin app secret against the token endpoint, stores it as `ADMIN_CLIENT_SECRET`, and releases auth.                                                                                                                                                     |
| `pnpm deploy:rotate admin-secret`        | New admin app secret: database, check, `vercel env update`, release.                                                                                                                                                                                                                                                                                                                   |
| `pnpm deploy:rotate db`                  | After a Neon password reset: checks that the URLs connect, then releases auth.                                                                                                                                                                                                                                                                                                         |

First deployment, in order:
1. `vercel login`.
2. Accept Neon's terms once: `vercel integration accept-terms neon`.
3. `pnpm deploy:setup`, then add the DNS records it prints.
4. `pnpm deploy:release auth`.
5. `pnpm deploy:bootstrap`.
6. `pnpm deploy:release admin`.

The sections below describe the same steps by hand.

## 1. Database

1. Create a Postgres database close to the Vercel region you will use (for example Neon or Supabase in Singapore, with the functions in `sin1`).
2. Note two URLs:
   - **pooled** (PgBouncer, transaction mode) → `DATABASE_URL`;
   - **direct** → used only by the build's migrations and by the bootstrap below. Neon's Vercel integration provides it as `DATABASE_URL_UNPOOLED`, which the build picks up on its own. With another provider, set it as `MIGRATION_DATABASE_URL`.

## 2. Secrets

Generate them locally and keep them in your password manager. Never commit them.

```bash
# OIDC_SIGNING_KEY: RSA private key as one line with literal \n
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | awk '{printf "%s\\n", $0}'
# CLIENT_SECRET_KEY: base64 of 32 bytes (encrypts client secrets at rest)
openssl rand -base64 32
# OIDC_COOKIE_KEYS: one or more, comma-separated (the first signs)
openssl rand -base64 32
# CRON_SECRET (>= 16 chars)
openssl rand -hex 32
```

There is no key rotation yet, so treat these values as permanent:
- a new `CLIENT_SECRET_KEY` makes every stored client secret unreadable;
- a new `OIDC_SIGNING_KEY` invalidates issued tokens.

## 3. `monexa-auth` project

Import `mngroups/monexa-auth` with framework preset **Other**. `vercel.json` already sets the install, build, output, function files, the rewrite and the daily cleanup cron.

Production env:

| Variable                         | Value                                                                  |
| -------------------------------- | ---------------------------------------------------------------------- |
| `GITLAB_NPM_TOKEN`               | GitLab token with `read_package_registry` (install time)               |
| `GITLAB_PACKAGE_GROUP_ID`        | `148122988`                                                            |
| `NODE_ENV`                       | `production`                                                           |
| `DATABASE_URL`                   | pooled URL                                                             |
| `MIGRATION_DATABASE_URL`         | direct URL; not needed with Neon (`DATABASE_URL_UNPOOLED` is used)     |
| `DB_POOL_MAX`                    | `2`                                                                    |
| `OIDC_ISSUER`                    | `https://auth.mngroup.id`                                              |
| `OIDC_SIGNING_KEY`               | from step 2                                                            |
| `OIDC_COOKIE_KEYS`               | from step 2                                                            |
| `CLIENT_SECRET_KEY`              | from step 2                                                            |
| `TRUST_PROXY`                    | `true` (client IPs for rate limits and lockout, `https` behind Vercel) |
| `CRON_SECRET`                    | from step 2 (Vercel sends it as the cron's bearer token)               |
| `ADMIN_REDIRECT_URIS`            | `https://auth-admin.mngroup.id/auth/callback`                          |
| `ADMIN_POST_LOGOUT_REDIRECT_URI` | `https://auth-admin.mngroup.id/login`                                  |
| `ADMIN_ORG_HINT`                 | `monexa` (optional: the org whose logo the admin login shows)          |
| `ADMIN_CLIENT_SECRET`            | leave empty until step 4                                               |

Leave `MIGRATE_ON_PREVIEW` unset so previews never migrate the production database. If Preview deployments must work, give them their own database and env.

Deploy, attach `auth.mngroup.id`, and check `https://auth.mngroup.id/health` (`status: ok`) and `/ready` (`db: ok`). The production build has applied the migrations.

## 4. Bootstrap (once)

Bootstrap creates the platform admin, the admin app, its catalog and roles, and the org "Monexa". Run it from a local checkout against the production database with the **same** `CLIENT_SECRET_KEY`. Otherwise the stored admin secret can't be decrypted.

```bash
cd monexa-auth
# A file outside the repo, never committed. Use the production values from step 3:
# DATABASE_URL (the direct URL), OIDC_ISSUER, OIDC_SIGNING_KEY, OIDC_COOKIE_KEYS, CLIENT_SECRET_KEY.
# Then add:
#   BOOTSTRAP_ADMIN_EMAIL=<your email>
#   BOOTSTRAP_ADMIN_PASSWORD=<a strong password>
#   BOOTSTRAP_ADMIN_REDIRECT_URIS=https://auth-admin.mngroup.id/auth/callback
#   BOOTSTRAP_ADMIN_POST_LOGOUT_REDIRECT_URIS=https://auth-admin.mngroup.id/login
set -a; . ~/monexa-auth.prod.env; set +a
pnpm auth:bootstrap
```

It prints the admin app's client secret **once**. Put it in the `monexa-auth` project as `ADMIN_CLIENT_SECRET` and redeploy. The kit's `/v1/auth/*` routes for the admin UI are mounted only with that secret.

Delete the local env file afterwards, or keep it only in your password manager. If the secret is lost, re-run with `BOOTSTRAP_ROTATE_ADMIN_SECRET=true`.

## 5. `monexa-auth-admin` project

Import `mngroups/monexa-auth-admin` with framework preset **Next.js**. Its `vercel.json` installs the private `@mono/*` packages.

Production env:

| Variable                  | Value                                         |
| ------------------------- | --------------------------------------------- |
| `GITLAB_NPM_TOKEN`        | as above                                      |
| `GITLAB_PACKAGE_GROUP_ID` | `148122988`                                   |
| `API_BASE_URL`            | `https://auth.mngroup.id`                     |
| `AUTH_MODE`               | `sso`                                         |
| `AUTH_PORTAL_URL`         | `https://auth.mngroup.id`                     |
| `AUTH_ORG_HINT`           | `monexa` (optional, same as `ADMIN_ORG_HINT`) |

Deploy and attach `auth-admin.mngroup.id`.

## 6. Smoke test

1. `https://auth-admin.mngroup.id`: you are sent to `auth.mngroup.id`. Sign in as the bootstrap admin, and you land back in the admin UI.
2. Create an app, a role and an org in the admin UI.
3. Log out. You go through `auth.mngroup.id`, then back to `/login`.
4. In the `monexa-auth` project, under Cron Jobs, run `/api/cron/cleanup` once. It answers `{ deleted: n }`. Without the bearer token it answers 401.

## Registering other apps

Every app (for example Project Tracker) is created in the admin UI with its production callback (`https://<app>/auth/callback`) and post-logout URL (`https://<app>/login`). In the app's env:
- `AUTH_ISSUER=https://auth.mngroup.id/oidc`;
- `AUTH_PORTAL_URL=https://auth.mngroup.id` on the FE.

## Rotating the database password

Reset the role's password in Neon (from `vercel integration open neon`: Connect → Reset password). The integration updates `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in Vercel, but a running deployment keeps the env it was built with, so **redeploy** right away. Until then, `/ready` answers 503. Don't copy the URLs into other variables by hand: a copy doesn't follow the next reset.

## Limits on Vercel

- **Cron:** Hobby plans run crons at most once a day, so the schedule is daily (`0 3 * * *`). On Pro it can be hourly.
- **Cold starts:** the first request after idle loads the app and the OIDC provider. Keep the function region next to the database.
- **Function region:** `vercel.json` pins `"regions": ["sin1"]`, next to the Neon database (a test checks it matches `deploy/vercel.config.json`). Without it Vercel runs functions in `iad1` (US East): every request and every query then crosses the Pacific. Check with the `x-vercel-id` response header: `sin1::sin1::…` is right, `sin1::iad1::…` is not.
- **Docker instead:** the Dockerfile and the CLI cleanup still work. See the README's Deployment section.
