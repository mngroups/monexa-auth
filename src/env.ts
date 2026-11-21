import { createPrivateKey } from "node:crypto";
import { defineEnv } from "@mono/server-kit";
import { z } from "zod";

/** Comma-separated list: entries trimmed, empty ones dropped. */
const list = (fallback: string[] = []) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined
        ? fallback
        : raw
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
    );

function isRsaPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(8080),
  LOG_LEVEL: z.string().default("info"),

  DATABASE_URL: z.url(),
  DB_POOL_MAX: int(10),

  OIDC_ISSUER: z.url(),
  OIDC_SIGNING_KEY: z
    .string()
    .min(1)
    // Hosts that store env on one line pass newlines as a literal `\n`.
    .transform((pem) => pem.replace(/\\n/g, "\n"))
    .refine(isRsaPrivateKey, "must be a PEM RSA private key"),
  OIDC_COOKIE_KEYS: list().refine((keys) => keys.length >= 1, "at least one key is required"),
  CLIENT_SECRET_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, "must be base64 of 32 bytes"),
  ADMIN_CLIENT_ID: z.string().min(1).default("monexa-admin"),
  LOCKOUT_MAX_FAILURES: int(5),
  LOCKOUT_MINUTES: int(15),

  CORS_ORIGINS: list(),
  // Behind a proxy that sets X-Forwarded-For (load balancer, Vercel), so `request.ip`
  // is the real client for anonymous rate limiting.
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  RATE_LIMIT_MAX: int(300),
  LOGIN_RATE_LIMIT_MAX: int(10),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses `process.env` (or `source`) at boot; the error names keys, never values.
 * An empty value (`PORT=`) counts as unset, as it does in most `.env` tooling.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const set = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  return defineEnv(envSchema, set);
}
