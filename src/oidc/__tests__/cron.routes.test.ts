import type { FastifyInstance } from "fastify";
import { createTestDb } from "../../__tests__/db.js";
import { testEnv } from "../../__tests__/helpers.js";
import { buildApp } from "../../app.js";
import type { Db } from "../../db/client.js";
import { oidcStore } from "../../db/schema/index.js";

const SECRET = "cron-secret-0123456789abcdef";

let db: Db;
let close: () => Promise<void>;
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await close();
});

async function app(overrides: Record<string, string> = {}) {
  const instance = await buildApp({ env: testEnv(overrides), db });
  apps.push(instance);
  return instance;
}

const cleanup = (a: FastifyInstance, authorization?: string) =>
  a.inject({
    url: "/api/cron/cleanup",
    headers: authorization ? { authorization } : {},
  });

describe("GET /api/cron/cleanup", () => {
  it("does not exist without CRON_SECRET", async () => {
    const res = await cleanup(await app(), `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(404);
  });

  it("rejects a missing or wrong bearer token", async () => {
    const a = await app({ CRON_SECRET: SECRET });
    expect((await cleanup(a)).statusCode).toBe(401);
    expect((await cleanup(a, "Bearer nope")).statusCode).toBe(401);
    expect((await cleanup(a, SECRET)).statusCode).toBe(401);
  });

  it("deletes expired oidc_store rows and reports the count", async () => {
    await db.insert(oidcStore).values([
      { id: "cron-old", kind: "Session", payload: {}, expiresAt: new Date(Date.now() - 60_000) },
      { id: "cron-live", kind: "Session", payload: {}, expiresAt: new Date(Date.now() + 60_000) },
    ]);
    const res = await cleanup(await app({ CRON_SECRET: SECRET }), `Bearer ${SECRET}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: { deleted: 1 } });
    const left = await db.select({ id: oidcStore.id }).from(oidcStore);
    expect(left.map((r) => r.id)).toContain("cron-live");
    expect(left.map((r) => r.id)).not.toContain("cron-old");
  });

  it("refuses a CRON_SECRET shorter than 16 characters", () => {
    expect(() => testEnv({ CRON_SECRET: "short" })).toThrow(/CRON_SECRET/);
  });
});
