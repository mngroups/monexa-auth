import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import {
  AppError,
  createServerOptions,
  envelope,
  errorHandler,
  health,
  requestId,
} from "@mono/server-kit";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from "fastify-type-provider-zod";
import type Provider from "oidc-provider";
import { ACCOUNT_PASSWORD_PATH, accountRoutes } from "./account/routes.js";
import { orgAdminRoutes } from "./admin/org/index.js";
import { platformRoutes } from "./admin/platform/index.js";
import { adminClientAuth } from "./admin-client/routes.js";
import { LOGO_MAX_BYTES } from "./branding/logo-file.js";
import { brandingPublicRoutes } from "./branding/public.routes.js";
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { meRoutes } from "./me/routes.js";
import { interactionAssets } from "./oidc/interactions/assets.js";
import { interactionRoutes } from "./oidc/interactions/routes.js";
import { mountProvider, OIDC_PREFIX } from "./oidc/mount.js";
import { createProvider } from "./oidc/provider.js";

/** App copy that complements the kit's `MESSAGES`. */
export const MESSAGES_APP = {
  rateLimited: "Terlalu banyak permintaan, coba lagi nanti",
} as const;

export type BuildAppOptions = {
  env: Env;
  db: Db;
  closeDb?: () => Promise<void>;
  /** Defaults to `createProvider({ env, db })`. */
  provider?: Provider;
};

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

/** `METHOD url` of the routes with the tighter `LOGIN_RATE_LIMIT_MAX`, keyed by identifier. */
const STRICT_RATE_LIMIT_ROUTES = new Set<string>([`POST ${ACCOUNT_PASSWORD_PATH}`]);
const PROBE_ROUTES = new Set(["/health", "/ready"]);

/** Keyed by client IP (real only with TRUST_PROXY behind a proxy). */
function rateLimitKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

/**
 * Strict routes count per submitted identifier (trimmed, lower-cased), so one account can't be
 * guessed at from many IPs; no identifier falls back to the IP. Runs in preHandler, after the
 * body is parsed.
 */
function strictRateLimitKey(request: FastifyRequest): string {
  const identifier = (request.body as { identifier?: unknown } | undefined)?.identifier;
  const id = typeof identifier === "string" ? identifier.trim().toLowerCase() : "";
  return id ? `id:${id}` : rateLimitKey(request);
}

/** Builds the app without listening; `src/server.ts` (Docker) and `api/index.ts` (Vercel) share it. */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { env } = opts;
  const app = Fastify({
    ...createServerOptions({ logLevel: env.LOG_LEVEL }),
    trustProxy: env.TRUST_PROXY,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // #region handbook:app-wiring
  // Registered first so it sees every route (`pnpm openapi` writes the spec).
  await app.register(swagger, {
    openapi: {
      info: { title: "Monexa Auth", version },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(requestId);
  await app.register(envelope);
  await app.register(errorHandler);
  // The sign-in pages widen `form-action` per response (src/oidc/interactions/csp.ts).
  await app.register(helmet);
  if (env.CORS_ORIGINS.length > 0) await app.register(cors, { origin: env.CORS_ORIGINS });

  // Must run before rate-limit's own onRoute hook reads `config.rateLimit`.
  app.addHook("onRoute", (route) => {
    if ([route.method].flat().some((m) => STRICT_RATE_LIMIT_ROUTES.has(`${m} ${route.url}`))) {
      route.config = {
        ...route.config,
        rateLimit: {
          max: env.LOGIN_RATE_LIMIT_MAX,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: strictRateLimitKey,
        },
      };
    }
    // Probes must never be throttled: a 429 on /ready takes the instance out of rotation.
    if (PROBE_ROUTES.has(route.url)) route.config = { ...route.config, rateLimit: false };
    // App backends call the provider from one server IP for all their users, so a per-IP
    // limit would throttle everyone; password guessing is stopped by account lockout.
    if (route.url.startsWith(`${OIDC_PREFIX}/`)) {
      route.config = { ...route.config, rateLimit: false };
    }
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: rateLimitKey,
    errorResponseBuilder: () => new AppError(429, MESSAGES_APP.rateLimited),
  });

  await app.register(health, { checks: { db: () => opts.db.execute(sql`select 1`) } });
  // #endregion

  // Logo uploads only: one file, cut at the limit (flagged `truncated`) instead of throwing.
  await app.register(multipart, {
    limits: { fileSize: LOGO_MAX_BYTES, files: 1 },
    throwFileSizeLimit: false,
  });
  await app.register(meRoutes, { db: opts.db, env });
  await app.register(brandingPublicRoutes, { db: opts.db });
  const provider = opts.provider ?? createProvider({ env, db: opts.db });
  await mountProvider(app, provider);
  await app.register(interactionRoutes, { db: opts.db, env, provider });
  await app.register(interactionAssets);
  await app.register(accountRoutes, { db: opts.db, env });
  await app.register(platformRoutes, { db: opts.db, env });
  await app.register(orgAdminRoutes, { db: opts.db, env });
  if (env.ADMIN_CLIENT_SECRET) {
    await adminClientAuth(app, { env, clientSecret: env.ADMIN_CLIENT_SECRET });
  }

  const { closeDb } = opts;
  if (closeDb) app.addHook("onClose", async () => closeDb());

  return app;
}
