import { generateKeyPairSync } from "node:crypto";
import type { FastifyInstance } from "fastify";

/** Valid but throwaway: generated per process, never persisted. */
export function throwawaySigningKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Placeholder env for generating the spec: nothing connects and no secret is real. */
export const OPENAPI_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://openapi:openapi@127.0.0.1:5432/openapi",
  OIDC_ISSUER: "http://127.0.0.1:8080",
  OIDC_SIGNING_KEY: throwawaySigningKey(),
  OIDC_COOKIE_KEYS: "openapi",
  CLIENT_SECRET_KEY: Buffer.alloc(32).toString("base64"),
} satisfies NodeJS.ProcessEnv;

/** The OpenAPI document `@fastify/swagger` built from every route's Zod schemas. */
export async function generateOpenApi(app: FastifyInstance): Promise<object> {
  await app.ready();
  return app.swagger();
}
