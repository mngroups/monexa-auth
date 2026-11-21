import { readFileSync } from "node:fs";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
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
import type { Db } from "./db/client.js";
import type { Env } from "./env.js";
import { mountProvider } from "./oidc/mount.js";
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

const STRICT_RATE_LIMIT_ROUTES = new Set(["/v1/auth/login", "/v1/auth/callback"]);
const PROBE_ROUTES = new Set(["/health", "/ready"]);

/** Keyed by client IP (real only with TRUST_PROXY behind a proxy). */
function rateLimitKey(request: FastifyRequest): string {
  return `ip:${request.ip}`;
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
    openapi: { info: { title: "Monexa Auth", version } },
    transform: jsonSchemaTransform,
  });
  await app.register(requestId);
  await app.register(envelope);
  await app.register(errorHandler);
  await app.register(helmet);
  if (env.CORS_ORIGINS.length > 0) await app.register(cors, { origin: env.CORS_ORIGINS });

  // Must run before rate-limit's own onRoute hook reads `config.rateLimit`.
  app.addHook("onRoute", (route) => {
    if (STRICT_RATE_LIMIT_ROUTES.has(route.url)) {
      route.config = {
        ...route.config,
        rateLimit: { max: env.LOGIN_RATE_LIMIT_MAX, timeWindow: "1 minute" },
      };
    }
    // Probes must never be throttled: a 429 on /ready takes the instance out of rotation.
    if (PROBE_ROUTES.has(route.url)) route.config = { ...route.config, rateLimit: false };
  });
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: "1 minute",
    keyGenerator: rateLimitKey,
    errorResponseBuilder: () => new AppError(429, MESSAGES_APP.rateLimited),
  });

  await app.register(health, { checks: { db: () => opts.db.execute(sql`select 1`) } });
  // #endregion

  await mountProvider(app, opts.provider ?? createProvider({ env, db: opts.db }));

  const { closeDb } = opts;
  if (closeDb) app.addHook("onClose", async () => closeDb());

  return app;
}
