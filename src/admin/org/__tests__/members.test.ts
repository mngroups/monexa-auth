import { eq } from "drizzle-orm";
import {
  addMember,
  assignRole,
  enableApp,
  getUser,
  seedApp,
  seedRole,
  seedUser,
} from "../../../__tests__/fixtures.js";
import { memberRoles, memberships, oidcStore } from "../../../db/schema/index.js";
import { MESSAGES_AUTH } from "../../../messages.js";
import { verifyPassword } from "../../../users/passwords.js";
import { activityOf, allActivity, MISSING_ID } from "../../__tests__/harness.js";
import { bootOrg, type OrgHarness } from "./harness.js";

let h: OrgHarness;
beforeAll(async () => {
  h = await bootOrg();
});
afterAll(async () => h.close());

const rows = (userId: string) => h.db.select().from(oidcStore).where(eq(oidcStore.userId, userId));
const refresh = (id: string, userId: string, orgId: string) =>
  h.db.insert(oidcStore).values([
    { id: `g-${id}`, kind: "Grant", payload: { clientId: "x" }, userId, orgId },
    {
      id: `rt-${id}`,
      kind: "RefreshToken",
      payload: { clientId: "x" },
      grantId: `g-${id}`,
      userId,
      orgId,
    },
  ]);
const hasRefresh = async (id: string) =>
  (
    await h.db
      .select()
      .from(oidcStore)
      .where(eq(oidcStore.id, `rt-${id}`))
  ).length === 1;

describe("org members, end to end", () => {
  it("creates a user with a temporary password, lists them with roles, and adds an existing user by email", async () => {
    const created = await h.call("POST", "/members", {
      email: "fresh@example.com",
      name: "Fresh Hire",
      temporaryPassword: "temp-pass-123",
    });
    expect(created.statusCode).toBe(200);
    const member = created.json().data;
    expect(member).toMatchObject({
      email: "fresh@example.com",
      isActive: true,
      mustChangePassword: true,
    });
    expect(created.body).not.toContain("temp-pass-123");
    const user = await getUser(h.db, member.userId);
    expect(await verifyPassword(user.passwordHash ?? "", "temp-pass-123")).toBe(true);
    const createdRows = await activityOf(h.db, "admin.member.created");
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toMatchObject({
      orgId: h.orgA.id,
      actorUserId: h.admin.id,
      targetId: member.userId,
    });
    expect(JSON.stringify(createdRows[0])).not.toContain("temp-pass-123");

    const existing = await seedUser(h.db, { email: "exists@example.com" });
    const added = await h.call("POST", "/members/existing", { email: "EXISTS@example.com" });
    expect(added.statusCode).toBe(200);
    expect(added.json().data.userId).toBe(existing.id);
    expect(
      (await activityOf(h.db, "admin.member.added")).filter((r) => r.targetId === existing.id)
    ).toHaveLength(1);
    expect(
      (await h.call("POST", "/members/existing", { email: "exists@example.com" })).statusCode
    ).toBe(409);

    const role = await seedRole(h.db, h.adminApp.id, "viewer");
    await assignRole(h.db, existing.id, h.orgA.id, role.id);
    const list = (await h.call("GET", "/members")).json().data;
    const item = list.items.find((m: { userId: string }) => m.userId === existing.id);
    expect(item.roles).toEqual([{ id: role.id, name: "viewer", appId: h.adminApp.id }]);
    expect(JSON.stringify(list)).not.toContain("passwordHash");
    expect((await h.call("GET", "/members?q=fresh")).json().data.total).toBe(1);
  });

  it("answers 404 when adding an unknown email, 409/422 on bad creates, with no activity", async () => {
    const before = (await allActivity(h.db)).length;
    const none = await h.call("POST", "/members/existing", { email: "ghost@example.com" });
    expect(none.statusCode).toBe(404);
    expect(none.json().message).toBe(MESSAGES_AUTH.userNotFound);
    const dup = { email: "fresh@example.com", name: "Dup", temporaryPassword: "temp-pass-123" };
    expect((await h.call("POST", "/members", dup)).statusCode).toBe(409);
    expect(
      (await h.call("POST", "/members", { ...dup, email: "n@example.com", temporaryPassword: "x" }))
        .statusCode
    ).toBe(422);
    expect((await allActivity(h.db)).length).toBe(before);
  });

  it("removes a member with their roles and grants for this org only", async () => {
    const user = await seedUser(h.db);
    await addMember(h.db, user.id, h.orgA.id);
    await addMember(h.db, user.id, h.orgB.id);
    const role = await seedRole(h.db, h.adminApp.id, "to-remove");
    await assignRole(h.db, user.id, h.orgA.id, role.id);
    await refresh("rm-a", user.id, h.orgA.id);
    await refresh("rm-b", user.id, h.orgB.id);
    expect((await h.call("DELETE", `/members/${user.id}`)).statusCode).toBe(200);
    expect(
      await h.db.select().from(memberships).where(eq(memberships.userId, user.id))
    ).toHaveLength(1);
    expect(
      await h.db.select().from(memberRoles).where(eq(memberRoles.userId, user.id))
    ).toHaveLength(0);
    expect(await hasRefresh("rm-a")).toBe(false);
    expect(await hasRefresh("rm-b")).toBe(true);
    expect(
      (await activityOf(h.db, "admin.member.removed")).filter((r) => r.targetId === user.id)
    ).toHaveLength(1);
  });

  it("deactivating a membership ends A's refresh only; activating restores the flag", async () => {
    const user = await seedUser(h.db);
    await addMember(h.db, user.id, h.orgA.id);
    await addMember(h.db, user.id, h.orgB.id);
    await refresh("de-a", user.id, h.orgA.id);
    await refresh("de-b", user.id, h.orgB.id);
    const off = await h.call("POST", `/members/${user.id}/deactivate`);
    expect(off.json().data.isActive).toBe(false);
    expect(await hasRefresh("de-a")).toBe(false);
    expect(await hasRefresh("de-b")).toBe(true);
    const [b] = await h.db.select().from(memberships).where(eq(memberships.orgId, h.orgB.id));
    expect(b?.isActive).toBe(true);
    expect((await h.call("POST", `/members/${user.id}/activate`)).json().data.isActive).toBe(true);
    for (const action of ["admin.member.deactivated", "admin.member.activated"]) {
      expect((await activityOf(h.db, action)).filter((r) => r.targetId === user.id)).toHaveLength(
        1
      );
    }
  });

  it("resets the password of a user only in A: temp password, must_change, all grants gone", async () => {
    const user = await seedUser(h.db);
    await addMember(h.db, user.id, h.orgA.id);
    await refresh("pw", user.id, h.orgA.id);
    await h.db
      .insert(oidcStore)
      .values({ id: "s-pw", kind: "Session", payload: {}, userId: user.id });
    const res = await h.call("POST", `/members/${user.id}/reset-password`, {
      temporaryPassword: "reset-pass-123",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("reset-pass-123");
    const after = await getUser(h.db, user.id);
    expect(after.mustChangePassword).toBe(true);
    expect(await verifyPassword(after.passwordHash ?? "", "reset-pass-123")).toBe(true);
    expect(await rows(user.id)).toEqual([]);
    const log = (await activityOf(h.db, "admin.member.password_reset")).filter(
      (r) => r.targetId === user.id
    );
    expect(log).toHaveLength(1);
    expect(JSON.stringify(log[0])).not.toContain("reset-pass-123");
  });

  it("refuses a reset (403 resetNotAllowed) for a user also in B, or a platform admin", async () => {
    const both = await seedUser(h.db);
    await addMember(h.db, both.id, h.orgA.id);
    await addMember(h.db, both.id, h.orgB.id);
    await refresh("pw-both", both.id, h.orgA.id);
    const before = (await allActivity(h.db)).length;
    const res = await h.call("POST", `/members/${both.id}/reset-password`, {
      temporaryPassword: "reset-pass-123",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe(MESSAGES_AUTH.resetNotAllowed);
    expect(await hasRefresh("pw-both")).toBe(true);
    const pa = await seedUser(h.db, { isPlatformAdmin: true });
    await addMember(h.db, pa.id, h.orgA.id);
    expect(
      (
        await h.call("POST", `/members/${pa.id}/reset-password`, {
          temporaryPassword: "reset-pass-123",
        })
      ).statusCode
    ).toBe(403);
    expect((await allActivity(h.db)).length).toBe(before);
  });

  it("treats users who are not members of A as 404 on every member route, touching nothing", async () => {
    const outsider = await seedUser(h.db);
    await addMember(h.db, outsider.id, h.orgB.id);
    await refresh("out", outsider.id, h.orgB.id);
    const before = (await allActivity(h.db)).length;
    const pw = { temporaryPassword: "reset-pass-123" };
    const calls = [
      h.call("DELETE", `/members/${outsider.id}`),
      h.call("POST", `/members/${outsider.id}/deactivate`),
      h.call("POST", `/members/${outsider.id}/activate`),
      h.call("POST", `/members/${outsider.id}/reset-password`, pw),
      h.call("PUT", `/members/${outsider.id}/roles`, { roleIds: [] }),
      h.call("DELETE", `/members/${MISSING_ID}`),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(outsider.email);
    }
    expect(await hasRefresh("out")).toBe(true);
    expect(
      await h.db.select().from(memberships).where(eq(memberships.userId, outsider.id))
    ).toHaveLength(1);
    expect((await allActivity(h.db)).length).toBe(before);
    const list = JSON.stringify((await h.call("GET", "/members")).json());
    expect(list).not.toContain(outsider.email);
  });
});

describe("member roles", () => {
  it("replaces a member's roles when every role's app is enabled for the org", async () => {
    const user = await seedUser(h.db);
    await addMember(h.db, user.id, h.orgA.id);
    const app = await seedApp(h.db);
    await enableApp(h.db, h.orgA.id, app.id);
    const [r1, r2] = [await seedRole(h.db, app.id, "r1"), await seedRole(h.db, app.id, "r2")];
    const set = (roleIds: string[]) => h.call("PUT", `/members/${user.id}/roles`, { roleIds });
    const res = await set([r1.id, r2.id, r1.id]);
    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .data.roles.map((r: { name: string }) => r.name)
        .sort()
    ).toEqual(["r1", "r2"]);
    expect((await set([r2.id])).json().data.roles).toHaveLength(1);
    expect(
      await h.db.select().from(memberRoles).where(eq(memberRoles.userId, user.id))
    ).toHaveLength(1);
    expect((await set([])).json().data.roles).toEqual([]);
    expect(
      (await activityOf(h.db, "admin.member.roles_set")).filter((r) => r.targetId === user.id)
    ).toHaveLength(3);
  });

  it("answers 422 for a role of an app not enabled for A or an unknown role, changing nothing", async () => {
    const user = await seedUser(h.db);
    await addMember(h.db, user.id, h.orgA.id);
    const keep = await seedRole(h.db, h.adminApp.id, "keep");
    await assignRole(h.db, user.id, h.orgA.id, keep.id);
    const foreign = await seedRole(h.db, (await seedApp(h.db)).id, "foreign");
    const before = (await allActivity(h.db)).length;
    for (const roleId of [foreign.id, MISSING_ID]) {
      const res = await h.call("PUT", `/members/${user.id}/roles`, { roleIds: [keep.id, roleId] });
      expect(res.statusCode).toBe(422);
    }
    expect(
      await h.db.select().from(memberRoles).where(eq(memberRoles.userId, user.id))
    ).toHaveLength(1);
    expect((await allActivity(h.db)).length).toBe(before);
  });

  it("requires org.role:assign for roles and org.member:manage for members", async () => {
    const onlyAssign = await h.tokenFor(h.admin.id, h.orgA.id, ["org.role:assign"]);
    expect((await h.call("GET", "/members", undefined, onlyAssign)).statusCode).toBe(403);
    const onlyManage = await h.tokenFor(h.admin.id, h.orgA.id, ["org.member:manage"]);
    expect(
      (await h.call("PUT", `/members/${h.admin.id}/roles`, { roleIds: [] }, onlyManage)).statusCode
    ).toBe(403);
    expect((await h.call("GET", "/members", undefined, onlyManage)).statusCode).toBe(200);
  });
});

describe("self and platform-admin protection", () => {
  it("refuses an admin changing their own roles, membership or activation (422), changing nothing", async () => {
    const role = await seedRole(h.db, h.adminApp.id, "self-escalate");
    const before = (await allActivity(h.db)).length;
    const calls = [
      h.call("PUT", `/members/${h.admin.id}/roles`, { roleIds: [role.id] }),
      h.call("POST", `/members/${h.admin.id}/deactivate`),
      h.call("DELETE", `/members/${h.admin.id}`),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe(MESSAGES_AUTH.selfActionNotAllowed);
    }
    expect(
      await h.db.select().from(memberRoles).where(eq(memberRoles.userId, h.admin.id))
    ).toHaveLength(0);
    const [m] = await h.db.select().from(memberships).where(eq(memberships.userId, h.admin.id));
    expect(m?.isActive).toBe(true);
    expect((await allActivity(h.db)).length).toBe(before);
  });

  it("refuses remove, deactivate and role changes on a platform admin (403), keeping their grants", async () => {
    const pa = await seedUser(h.db, { isPlatformAdmin: true });
    await addMember(h.db, pa.id, h.orgA.id);
    await refresh("pa", pa.id, h.orgA.id);
    const role = await seedRole(h.db, h.adminApp.id, "pa-role");
    const before = (await allActivity(h.db)).length;
    const calls = [
      h.call("DELETE", `/members/${pa.id}`),
      h.call("POST", `/members/${pa.id}/deactivate`),
      h.call("PUT", `/members/${pa.id}/roles`, { roleIds: [role.id] }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toBe(MESSAGES_AUTH.platformAdminProtected);
    }
    expect(await hasRefresh("pa")).toBe(true);
    expect(await h.db.select().from(memberships).where(eq(memberships.userId, pa.id))).toHaveLength(
      1
    );
    expect((await allActivity(h.db)).length).toBe(before);
  });
});
