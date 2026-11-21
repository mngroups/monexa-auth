import { type Env, loadEnv } from "../env.js";
import { throwawaySigningKey } from "../openapi.js";

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://monexa:monexa@127.0.0.1:1/monexa",
    OIDC_ISSUER: "http://localhost:8080",
    OIDC_SIGNING_KEY: throwawaySigningKey(),
    OIDC_COOKIE_KEYS: "test-cookie-key",
    CLIENT_SECRET_KEY: Buffer.alloc(32, 1).toString("base64"),
    ...overrides,
  });
}

/** A database stand-in whose health query succeeds. */
export const okDb = { execute: async () => ({ rows: [] }) };
