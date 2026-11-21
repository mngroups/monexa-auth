import { createTestDb } from "../../__tests__/db.js";
import type { Db } from "../../db/client.js";
import { oidcStore } from "../../db/schema/index.js";
import { cleanupExpired } from "../cleanup.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("cleanupExpired", () => {
  it("deletes only rows past expires_at and returns the count", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const at = (ms: number) => new Date(now.getTime() + ms);
    await db.insert(oidcStore).values([
      { id: "old", kind: "Session", payload: {}, expiresAt: at(-1000) },
      { id: "old2", kind: "Interaction", payload: {}, expiresAt: at(-1) },
      { id: "live", kind: "Session", payload: {}, expiresAt: at(1000) },
      { id: "never", kind: "Grant", payload: {}, expiresAt: null },
    ]);

    expect(await cleanupExpired(db, now)).toBe(2);
    const left = await db.select({ id: oidcStore.id }).from(oidcStore);
    expect(left.map((r) => r.id).sort()).toEqual(["live", "never"]);
    expect(await cleanupExpired(db, now)).toBe(0);
  });
});
