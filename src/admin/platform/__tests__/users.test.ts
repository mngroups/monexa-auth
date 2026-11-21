import { eq } from "drizzle-orm";
import {
  addMember,
  enableApp,
  seedClient,
  seedOrg,
  seedUser,
} from "../../../__tests__/fixtures.js";
import { resolveAccess } from "../../../access/permissions.js";
import { oidcStore, users } from "../../../db/schema/index.js";
import { MESSAGES_AUTH } from "../../../messages.js";
import { hashPassword, verifyPassword } from "../../../users/passwords.js";
import {
  type Admin,
  activityOf,
  allActivity,
  bootAdmin,
  MISSING_ID,
  mintToken,
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

describe("platform password reset", () => {
  /** A real token request through the provider mounted in the app. */
  const tokenRequest = async (clientId: string, secret: string, params: Record<string, string>) => {
    const res = await h.app.inject({
      method: "POST",
      url: "/oidc/token",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: new URLSearchParams(params).toString(),
    });
    return { status: res.statusCode, body: res.json() as Record<string, string> };
  };

  /** The caller's admin-app token with the permissions `resolveAccess` gives a platform admin. */
  async function callerToken(orgId: string) {
    const access = await resolveAccess(h.db, {
      userId: h.user.id,
      appId: h.adminApp.id,
      orgId,
      adminClientId: h.env.ADMIN_CLIENT_ID,
    });
    if (!access.ok) throw new Error(access.reason);
    return mintToken(h.env, { sub: h.user.id, orgId, permissions: access.permissions });
  }

  const reset = (token: string, id: string, temporaryPassword: string) =>
    h.app.inject({
      method: "POST",
      url: `/api/admin/platform/users/${id}/reset-password`,
      payload: { temporaryPassword },
      headers: { authorization: `Bearer ${token}` },
    });

  it("resets a multi-org user: temporary password, must_change_password, every grant ended, one clean row", async () => {
    const orgA = await seedOrg(h.db);
    const orgB = await seedOrg(h.db);
    const { app, secret } = await seedClient(h.db, Buffer.from(h.env.CLIENT_SECRET_KEY, "base64"), {
      allowedGrants: ["password"],
    });
    const target = await seedUser(h.db, { passwordHash: await hashPassword("old-password-1") });
    for (const org of [orgA, orgB]) {
      await enableApp(h.db, org.id, app.id);
      await addMember(h.db, target.id, org.id);
    }
    const login = await tokenRequest(app.clientId, secret, {
      grant_type: "password",
      username: target.email,
      password: "old-password-1",
      scope: "openid",
    });
    expect(login.status).toBe(200);

    const token = await callerToken(orgA.id);
    const res = await reset(token, target.id, "reset-pass-123");
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: target.id, mustChangePassword: true });
    expect(res.body).not.toContain("reset-pass-123");
    const [row] = await h.db.select().from(users).where(eq(users.id, target.id));
    expect(row?.mustChangePassword).toBe(true);
    expect(await verifyPassword(row?.passwordHash ?? "", "reset-pass-123")).toBe(true);

    const refreshed = await tokenRequest(app.clientId, secret, {
      grant_type: "refresh_token",
      refresh_token: login.body.refresh_token as string,
    });
    expect(refreshed).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

    const rows = (await activityOf(h.db, "admin.user.password_reset")).filter(
      (r) => r.targetId === target.id
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: h.user.id, orgId: null });
    expect(JSON.stringify(rows[0])).not.toContain("reset-pass-123");
    expect(JSON.stringify(rows[0])).not.toContain(row?.passwordHash ?? "never");
  });

  it("resets another platform admin; refuses yourself (422), weak passwords (422) and unknown users (404)", async () => {
    const org = await seedOrg(h.db);
    const token = await callerToken(org.id);
    const peer = await seedUser(h.db, { isPlatformAdmin: true });
    expect((await reset(token, peer.id, "reset-pass-123")).statusCode).toBe(200);

    const before = (await allActivity(h.db)).length;
    const self = await reset(token, h.user.id, "reset-pass-123");
    expect(self.statusCode).toBe(422);
    expect(self.json().message).toBe(MESSAGES_AUTH.selfActionNotAllowed);
    expect((await reset(token, peer.id, "short")).statusCode).toBe(422);
    expect((await reset(token, MISSING_ID, "reset-pass-123")).statusCode).toBe(404);
    expect((await allActivity(h.db)).length).toBe(before);
  });
});
