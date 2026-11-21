import { createTestDb } from "../../__tests__/db.js";
import type { Db } from "../../db/client.js";
import { activityLog } from "../../db/schema/index.js";
import { logActivity } from "../log.js";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("logActivity", () => {
  it("writes one row with all fields", async () => {
    await logActivity(db, {
      actorUserId: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000002",
      action: "auth.login.succeeded",
      targetType: "user",
      targetId: "00000000-0000-4000-8000-000000000001",
      ip: "203.0.113.9",
      userAgent: "ua",
      metadata: { client_id: "app-1" },
    });
    const rows = await db.select().from(activityLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000002",
      action: "auth.login.succeeded",
      targetType: "user",
      targetId: "00000000-0000-4000-8000-000000000001",
      ip: "203.0.113.9",
      userAgent: "ua",
      metadata: { client_id: "app-1" },
    });
  });

  it("defaults optional fields to null and metadata to {}", async () => {
    await db.delete(activityLog);
    await logActivity(db, {
      actorUserId: null,
      orgId: null,
      action: "auth.login.failed",
      targetType: "user",
      targetId: "someone",
    });
    const [row] = await db.select().from(activityLog);
    expect(row).toMatchObject({
      actorUserId: null,
      orgId: null,
      ip: null,
      userAgent: null,
      metadata: {},
    });
  });
});
