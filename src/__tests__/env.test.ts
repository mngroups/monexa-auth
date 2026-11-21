import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { loadEnv } from "../env.js";
import { throwawaySigningKey } from "../openapi.js";

const minimal = {
  DATABASE_URL: "postgres://monexa:monexa@localhost:5432/monexa",
  OIDC_ISSUER: "http://localhost:8080",
  OIDC_SIGNING_KEY: throwawaySigningKey(),
  OIDC_COOKIE_KEYS: "k1",
  CLIENT_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("loadEnv", () => {
  it("applies defaults to a minimal env", () => {
    const env = loadEnv(minimal);
    expect(env).toMatchObject({
      NODE_ENV: "development",
      PORT: 8080,
      LOG_LEVEL: "info",
      DB_POOL_MAX: 10,
      OIDC_COOKIE_KEYS: ["k1"],
      ADMIN_CLIENT_ID: "monexa-admin",
      LOCKOUT_MAX_FAILURES: 5,
      LOCKOUT_MINUTES: 15,
      CORS_ORIGINS: [],
      RATE_LIMIT_MAX: 300,
      LOGIN_RATE_LIMIT_MAX: 10,
      TRUST_PROXY: false,
    });
  });

  it("trims list entries and drops empty ones", () => {
    const env = loadEnv({
      ...minimal,
      OIDC_COOKIE_KEYS: " a , ,b,",
      CORS_ORIGINS: "http://localhost:3000, ",
    });
    expect(env.OIDC_COOKIE_KEYS).toEqual(["a", "b"]);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("parses booleans and numbers from strings", () => {
    const env = loadEnv({ ...minimal, TRUST_PROXY: "true", PORT: "3001", LOCKOUT_MINUTES: "30" });
    expect(env).toMatchObject({ TRUST_PROXY: true, PORT: 3001, LOCKOUT_MINUTES: 30 });
  });

  it("requires at least one cookie key", () => {
    expect(() => loadEnv({ ...minimal, OIDC_COOKIE_KEYS: " , " })).toThrow(/OIDC_COOKIE_KEYS/);
  });

  it("rejects a CLIENT_SECRET_KEY that is not 32 bytes, naming it but not echoing it", () => {
    const short = Buffer.alloc(16, 9).toString("base64");
    let message = "";
    try {
      loadEnv({ ...minimal, CLIENT_SECRET_KEY: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("CLIENT_SECRET_KEY");
    expect(message).not.toContain(short);
  });

  it("requires an RSA private key, and accepts literal \\n escapes", () => {
    expect(() => loadEnv({ ...minimal, OIDC_SIGNING_KEY: "not a pem" })).toThrow(
      /OIDC_SIGNING_KEY/
    );
    const escaped = minimal.OIDC_SIGNING_KEY.trim().replace(/\n/g, "\\n");
    expect(loadEnv({ ...minimal, OIDC_SIGNING_KEY: escaped }).OIDC_SIGNING_KEY).toContain("\n");
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => loadEnv({ ...minimal, OIDC_SIGNING_KEY: ec })).toThrow(/OIDC_SIGNING_KEY/);
  });

  it("names a missing variable without echoing any value", () => {
    const { DATABASE_URL: _omit, ...rest } = minimal;
    let message = "";
    try {
      loadEnv({ ...rest, LOCKOUT_MAX_FAILURES: "many" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("LOCKOUT_MAX_FAILURES");
    expect(message).not.toContain("many");
  });

  it("treats empty values as unset", () => {
    const env = loadEnv({ ...minimal, LOG_LEVEL: "", PORT: "" });
    expect(env.PORT).toBe(8080);
  });

  it("accepts the committed .env.example, including its dev RSA key", () => {
    const example = parseEnv(readFileSync(join(import.meta.dirname, "../../.env.example"), "utf8"));
    const env = loadEnv(example);
    expect(env.OIDC_SIGNING_KEY).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(Buffer.from(env.CLIENT_SECRET_KEY, "base64")).toHaveLength(32);
  });
});
