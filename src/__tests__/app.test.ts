import { MESSAGES } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import { buildApp, MESSAGES_APP } from "../app.js";
import { createDb } from "../db/client.js";
import { MESSAGES_AUTH } from "../messages.js";
import { PERMISSIONS } from "../permissions.js";
import { okDb, testEnv } from "./helpers.js";

const apps: FastifyInstance[] = [];

async function app(overrides: Record<string, string> = {}, db: unknown = okDb) {
  const instance = await buildApp({ env: testEnv(overrides), db: db as never });
  apps.push(instance);
  return instance;
}

afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

describe("buildApp", () => {
  it("serves health and envelope 404s", async () => {
    const a = await app();
    const health = await a.inject({ url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ success: true, data: { status: "ok" } });
    const ready = await a.inject({ url: "/ready" });
    expect(ready.json().data).toEqual({ checks: { db: "ok" } });
    const missing = await a.inject({ url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ success: false, code: 404 });
  });

  it("sends security headers", async () => {
    const res = await (await app()).inject({ url: "/health" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("enables CORS only for configured origins", async () => {
    const preflight = {
      method: "OPTIONS" as const,
      url: "/health",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    };
    const allowed = await (await app({ CORS_ORIGINS: "http://localhost:3000" })).inject(preflight);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const none = await (await app()).inject(preflight);
    expect(none.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("applies the global rate limit to anonymous routes", async () => {
    const a = await app({ RATE_LIMIT_MAX: "2" });
    a.get("/other", async (_req, reply) => reply.send({ ok: true }));
    await a.inject({ url: "/other" });
    await a.inject({ url: "/other" });
    const third = await a.inject({ url: "/other" });
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({
      success: false,
      code: 429,
      message: MESSAGES_APP.rateLimited,
      data: null,
    });
  });

  it("never rate-limits the OIDC provider routes", async () => {
    const a = await app({ RATE_LIMIT_MAX: "1" });
    for (let i = 0; i < 3; i += 1) {
      const res = await a.inject({
        method: "POST",
        url: "/oidc/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: "grant_type=password",
      });
      expect(res.statusCode).not.toBe(429);
      expect(res.json()).toMatchObject({ error: "invalid_request" });
    }
  });

  it("never rate-limits health and readiness probes", async () => {
    const a = await app({ RATE_LIMIT_MAX: "1" });
    for (let i = 0; i < 3; i += 1) {
      expect((await a.inject({ url: "/health" })).statusCode).toBe(200);
      expect((await a.inject({ url: "/ready" })).statusCode).toBe(200);
    }
  });

  it("uses X-Forwarded-For only when TRUST_PROXY is on", async () => {
    const hit = (a: FastifyInstance, ip: string) =>
      a.inject({ url: "/other", headers: { "x-forwarded-for": ip } });
    const trusted = await app({ RATE_LIMIT_MAX: "1", TRUST_PROXY: "true" });
    trusted.get("/other", async (_req, reply) => reply.send({ ok: true }));
    await hit(trusted, "203.0.113.1");
    expect((await hit(trusted, "203.0.113.2")).statusCode).toBe(200);
    const untrusted = await app({ RATE_LIMIT_MAX: "1" });
    untrusted.get("/other", async (_req, reply) => reply.send({ ok: true }));
    await hit(untrusted, "203.0.113.1");
    expect((await hit(untrusted, "203.0.113.2")).statusCode).toBe(429);
  });

  it("still boots with an unreachable database: readiness names the db", async () => {
    const { db, close } = createDb("postgres://u:p@127.0.0.1:1/x", 1);
    let closed = false;
    const instance = await buildApp({
      env: testEnv(),
      db,
      closeDb: async () => {
        closed = true;
        await close();
      },
    });
    expect((await instance.inject({ url: "/health" })).statusCode).toBe(200);
    const ready = await instance.inject({ url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().data).toEqual({ checks: { db: "fail" } });
    await instance.close();
    expect(closed).toBe(true);
  });

  it("exposes the admin permission catalog and Indonesian auth copy", () => {
    expect(PERMISSIONS).toEqual({
      platformAll: "platform:all",
      memberManage: "org.member:manage",
      roleAssign: "org.role:assign",
      activityView: "org.activity:view",
      brandingManage: "org.branding:manage",
    });
    expect(MESSAGES_AUTH).toMatchObject({
      noAppAccess: "Anda tidak memiliki akses ke aplikasi ini",
      passwordChangeRequired: "Anda harus mengganti password terlebih dahulu",
      orgNotEligible: "Anda tidak memiliki akses ke organisasi ini",
      resetNotAllowed:
        "User ini juga anggota organisasi lain; reset password hanya bisa dilakukan admin platform",
      invalidCredentials: MESSAGES.invalidCredentials,
      passwordTooShort: "Password baru minimal 8 karakter",
      passwordMismatch: "Konfirmasi password tidak sama",
    });
  });
});
