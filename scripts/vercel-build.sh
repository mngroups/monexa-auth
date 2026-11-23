#!/bin/sh
# Vercel build. Migrations run here (never at function boot), but only for
# production: a preview deployment would otherwise apply an unreviewed branch's
# migrations to whatever database Preview points at — often the production one.
# Opt previews in with MIGRATE_ON_PREVIEW=true when they have their own database.
# Migrations need a direct connection when DATABASE_URL points at a transaction pooler:
# MIGRATION_DATABASE_URL if set, else Neon's DATABASE_URL_UNPOOLED (kept in sync by the
# Neon integration, so a password reset needs no manual env change), else DATABASE_URL.
set -eu
if [ "${VERCEL_ENV:-}" = "production" ] || [ "${MIGRATE_ON_PREVIEW:-false}" = "true" ]; then
  DATABASE_URL="${MIGRATION_DATABASE_URL:-${DATABASE_URL_UNPOOLED:-$DATABASE_URL}}" pnpm db:migrate
else
  echo "skipping migrations on ${VERCEL_ENV:-unknown} deployment (set MIGRATE_ON_PREVIEW=true to opt in)"
fi
pnpm build
