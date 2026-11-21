import { eq } from "drizzle-orm";
import { seedUser } from "../../../__tests__/fixtures.js";
import { oidcStore, users } from "../../../db/schema/index.js";
import { verifyPassword } from "../../../users/passwords.js";
import {
  type Admin,
  activityOf,
  allActivity,
  bootAdmin,
  MISSING_ID,
} from "../../__tests__/harness.js";

let h: Admin;
beforeAll(async () => {
  h = await bootAdmin();
});
afterAll(async () => h.close());

describe("users", () => {
  it("creates a user with a temporary password and must_change_password, never exposing it", async () => {
    const res = await h.call("POST", "/users", {
      email: "New.Person@example.com",
      username: "new.person",
      name: "New Person",
      temporaryPassword: "temp-pass-123",
    });
    expect(res.statusCode).toBe(200);
    const user = res.json().data;
    expect(user).toMatchObject({
      username: "new.person",
      name: "New Person",
      isActive: true,
      isPlatformAdmin: false,
      mustChangePassword: true,
    });
    expect(res.body).not.toContain("temp-pass-123");
    expect(res.body).not.toContain("argon2");
    const [row] = await h.db.select().from(users).where(eq(users.id, user.id));
    expect(row?.mustChangePassword).toBe(true);
    expect(await verifyPassword(row?.passwordHash ?? "", "temp-pass-123")).toBe(true);

    const rows = await activityOf(h.db, "admin.user.created");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("temp-pass-123");
    expect(JSON.stringify(rows[0])).not.toContain(row?.passwordHash ?? "never");
    expect(rows[0]).toMatchObject({ actorUserId: h.user.id, targetId: user.id, orgId: null });
  });

  it("lists and searches by email, username or name, paginated", async () => {
    await seedUser(h.db, { email: "findme@example.com", name: "Zed Finder" });
    const byEmail = (await h.call("GET", "/users?q=findme")).json().data;
    expect(byEmail.total).toBe(1);
    expect(byEmail.items[0].email).toBe("findme@example.com");
    expect((await h.call("GET", "/users?q=Finder")).json().data.total).toBe(1);
    const all = (await h.call("GET", "/users?pageSize=1")).json().data;
    expect(all.items).toHaveLength(1);
    expect(all.total).toBeGreaterThan(1);
    expect(JSON.stringify(all)).not.toContain("passwordHash");
  });

  it("answers 422 for invalid input and 409 for a taken email or username, without activity", async () => {
    const before = (await allActivity(h.db)).length;
    const ok = {
      email: "dup@example.com",
      username: "dupuser",
      name: "Dup",
      temporaryPassword: "longenough1",
    };
    expect((await h.call("POST", "/users", ok)).statusCode).toBe(200);
    expect((await h.call("POST", "/users", { ...ok, username: "other" })).statusCode).toBe(409);
    expect(
      (await h.call("POST", "/users", { ...ok, email: "o@example.com", username: "DUPUSER" }))
        .statusCode
    ).toBe(409);
    expect((await h.call("POST", "/users", { ...ok, email: "not-an-email" })).statusCode).toBe(422);
    expect((await h.call("POST", "/users", { ...ok, temporaryPassword: "short" })).statusCode).toBe(
      422
    );
    expect((await h.call("POST", "/users", { ...ok, username: "a b" })).statusCode).toBe(422);
    expect((await h.call("POST", "/users", { email: "x@example.com" })).statusCode).toBe(422);
    expect((await allActivity(h.db)).length).toBe(before + 1);
  });
});

describe("platform admin", () => {
  it("grants and revokes it with one activity row each; revoking ends the user's admin-app grants", async () => {
    const target = await seedUser(h.db);
    const url = `/users/${target.id}/platform-admin`;
    expect((await h.call("PUT", url)).json().data.isPlatformAdmin).toBe(true);
    await h.db.insert(oidcStore).values({
      id: "admin-grant",
      kind: "Grant",
      payload: { clientId: h.env.ADMIN_CLIENT_ID },
      userId: target.id,
      orgId: null,
    });
    await h.db.insert(oidcStore).values({
      id: "other-grant",
      kind: "Grant",
      payload: { clientId: "some-app" },
      userId: target.id,
      orgId: null,
    });
    expect((await h.call("DELETE", url)).json().data.isPlatformAdmin).toBe(false);
    const left = await h.db
      .select({ id: oidcStore.id })
      .from(oidcStore)
      .where(eq(oidcStore.userId, target.id));
    expect(left.map((r) => r.id)).toEqual(["other-grant"]);

    for (const action of [
      "admin.user.platform_admin_granted",
      "admin.user.platform_admin_revoked",
    ]) {
      const rows = (await activityOf(h.db, action)).filter((r) => r.targetId === target.id);
      expect(rows, action).toHaveLength(1);
    }
  });

  it("refuses to revoke yourself (422) and answers 404/422 for bad targets", async () => {
    const before = (await allActivity(h.db)).length;
    expect((await h.call("DELETE", `/users/${h.user.id}/platform-admin`)).statusCode).toBe(422);
    expect((await h.call("PUT", `/users/${MISSING_ID}/platform-admin`)).statusCode).toBe(404);
    expect((await h.call("DELETE", `/users/${MISSING_ID}/platform-admin`)).statusCode).toBe(404);
    expect((await h.call("PUT", "/users/nope/platform-admin")).statusCode).toBe(422);
    expect((await allActivity(h.db)).length).toBe(before);
  });
});

describe("user activation", () => {
  it("deactivates (revoking all grants and sessions) and reactivates, one row each", async () => {
    const target = await seedUser(h.db);
    await h.db.insert(oidcStore).values([
      { id: "ua-grant", kind: "Grant", payload: { clientId: "x" }, userId: target.id, orgId: null },
      { id: "ua-sess", kind: "Session", payload: {}, userId: target.id },
    ]);
    const off = await h.call("POST", `/users/${target.id}/deactivate`);
    expect(off.json().data.isActive).toBe(false);
    const left = await h.db.select().from(oidcStore).where(eq(oidcStore.userId, target.id));
    expect(left).toEqual([]);
    expect((await h.call("POST", `/users/${target.id}/activate`)).json().data.isActive).toBe(true);
    for (const action of ["admin.user.deactivated", "admin.user.activated"]) {
      const rows = (await activityOf(h.db, action)).filter((r) => r.targetId === target.id);
      expect(rows, action).toHaveLength(1);
    }
  });

  it("refuses to deactivate yourself (422) and answers 404 for an unknown user", async () => {
    expect((await h.call("POST", `/users/${h.user.id}/deactivate`)).statusCode).toBe(422);
    expect((await h.call("POST", `/users/${MISSING_ID}/deactivate`)).statusCode).toBe(404);
    expect((await h.call("POST", `/users/${MISSING_ID}/activate`)).statusCode).toBe(404);
  });
});
