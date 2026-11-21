import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../__tests__/db.js";
import {
  addMember,
  assignRole,
  enableApp,
  seedApp,
  seedOrg,
  seedRole,
  seedUser,
} from "../../__tests__/fixtures.js";
import type { Db } from "../../db/client.js";
import { eligibleOrgs } from "../eligibility.js";
import { resolveAccess } from "../permissions.js";

let db: Db;
let close: () => Promise<void>;
const adminClientId = "monexa-admin";

let adminApp: Awaited<ReturnType<typeof seedApp>>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  adminApp = await seedApp(db, { clientId: adminClientId }, ["a:read"]);
});
afterAll(() => close());

async function world() {
  const app = await seedApp(db, {}, ["a:read", "a:write", "b:read"]);
  const user = await seedUser(db);
  return { app, user };
}

describe("eligibleOrgs", () => {
  it("returns active memberships in active orgs with the app enabled, ordered by name", async () => {
    const { app, user } = await world();
    const zed = await seedOrg(db, { name: "Zed" });
    const alpha = await seedOrg(db, { name: "Alpha" });
    const inactiveOrg = await seedOrg(db, { name: "Dead", isActive: false });
    const inactiveMember = await seedOrg(db, { name: "Left" });
    const noApp = await seedOrg(db, { name: "NoApp" });
    for (const o of [zed, alpha, inactiveOrg, inactiveMember, noApp]) {
      await addMember(db, user.id, o.id, o.id !== inactiveMember.id);
    }
    for (const o of [zed, alpha, inactiveOrg, inactiveMember]) await enableApp(db, o.id, app.id);

    expect(await eligibleOrgs(db, user.id, app.id, { adminClientId })).toEqual([
      { id: alpha.id, name: "Alpha", slug: alpha.slug },
      { id: zed.id, name: "Zed", slug: zed.slug },
    ]);
  });

  it("gives platform admins all active orgs for the admin app only", async () => {
    const admin = await seedUser(db, { isPlatformAdmin: true });
    const other = await seedApp(db);
    const live = await seedOrg(db, { name: "Live Admin Org" });
    await seedOrg(db, { name: "Dead Admin Org", isActive: false });

    const forAdmin = await eligibleOrgs(db, admin.id, adminApp.id, { adminClientId });
    expect(forAdmin.map((o) => o.id)).toContain(live.id);
    expect(forAdmin.map((o) => o.name)).not.toContain("Dead Admin Org");
    expect(await eligibleOrgs(db, admin.id, other.id, { adminClientId })).toEqual([]);

    const normal = await seedUser(db);
    expect(await eligibleOrgs(db, normal.id, adminApp.id, { adminClientId })).toEqual([]);
  });
});

describe("resolveAccess", () => {
  it("unions roles of this app, dedupes, sorts, and ignores other apps and removed catalog entries", async () => {
    const { app, user } = await world();
    const otherApp = await seedApp(db, {}, ["x:all"]);
    const org = await seedOrg(db);
    await addMember(db, user.id, org.id);
    await enableApp(db, org.id, app.id);
    const r1 = await seedRole(db, app.id, "r1", ["b:read", "a:write", "gone:perm"]);
    const r2 = await seedRole(db, app.id, "r2", [
      "a:read",
      "a:write",
      "platform:all",
      "platform:x",
    ]);
    const foreign = await seedRole(db, otherApp.id, "f", ["x:all"]);
    for (const r of [r1, r2, foreign]) await assignRole(db, user.id, org.id, r.id);

    const res = await resolveAccess(db, { userId: user.id, appId: app.id, adminClientId });
    expect(res).toEqual({
      ok: true,
      org: { id: org.id, name: org.name },
      permissions: ["a:read", "a:write", "b:read"],
    });
  });

  it("drops every platform permission from roles, platform.x:* included, even when catalogued", async () => {
    const app = await seedApp(db, {}, ["a:read", "platform.billing:read", "platform:all"]);
    const user = await seedUser(db);
    const org = await seedOrg(db);
    await addMember(db, user.id, org.id);
    await enableApp(db, org.id, app.id);
    const role = await seedRole(db, app.id, "sneaky", [
      "a:read",
      "platform.billing:read",
      "platform:all",
    ]);
    await assignRole(db, user.id, org.id, role.id);
    const res = await resolveAccess(db, { userId: user.id, appId: app.id, adminClientId });
    expect(res).toMatchObject({ ok: true, permissions: ["a:read"] });
  });

  it("adds platform:all for a platform admin on the admin app", async () => {
    const admin = await seedUser(db, { isPlatformAdmin: true });
    const org = await seedOrg(db, { name: "AAA admin target" });
    const res = await resolveAccess(db, {
      userId: admin.id,
      appId: adminApp.id,
      orgId: org.id,
      adminClientId,
    });
    expect(res).toEqual({
      ok: true,
      org: { id: org.id, name: org.name },
      permissions: ["platform:all"],
    });
  });

  it("does not add platform:all for a non-admin on the admin app or an admin elsewhere", async () => {
    const notAdminApp = await seedApp(db, { clientId: "other-admin-id" });
    const user = await seedUser(db);
    const org = await seedOrg(db);
    await addMember(db, user.id, org.id);
    await enableApp(db, org.id, notAdminApp.id);
    const res = await resolveAccess(db, { userId: user.id, appId: notAdminApp.id, adminClientId });
    expect(res).toMatchObject({ ok: true, permissions: [] });
  });

  it("rejects an ineligible explicit org", async () => {
    const { app, user } = await world();
    const org = await seedOrg(db);
    const stranger = await seedOrg(db);
    await addMember(db, user.id, org.id);
    await enableApp(db, org.id, app.id);
    expect(
      await resolveAccess(db, { userId: user.id, appId: app.id, orgId: stranger.id, adminClientId })
    ).toEqual({ ok: false, reason: "org_not_eligible" });
  });

  it("honours an explicit eligible org", async () => {
    const { app, user } = await world();
    const a = await seedOrg(db, { name: "A1" });
    const b = await seedOrg(db, { name: "B1" });
    for (const o of [a, b]) {
      await addMember(db, user.id, o.id);
      await enableApp(db, o.id, app.id);
    }
    const res = await resolveAccess(db, {
      userId: user.id,
      appId: app.id,
      orgId: b.id,
      adminClientId,
    });
    expect(res).toMatchObject({ ok: true, org: { id: b.id } });
  });

  it("uses lastOrgId when eligible, else the first eligible org by name", async () => {
    const { app, user } = await world();
    const a = await seedOrg(db, { name: "A2" });
    const b = await seedOrg(db, { name: "B2" });
    const stranger = await seedOrg(db, { name: "Stranger" });
    for (const o of [a, b]) {
      await addMember(db, user.id, o.id);
      await enableApp(db, o.id, app.id);
    }
    const last = await resolveAccess(db, {
      userId: user.id,
      appId: app.id,
      lastOrgId: b.id,
      adminClientId,
    });
    expect(last).toMatchObject({ ok: true, org: { id: b.id } });
    const fallback = await resolveAccess(db, {
      userId: user.id,
      appId: app.id,
      lastOrgId: stranger.id,
      adminClientId,
    });
    expect(fallback).toMatchObject({ ok: true, org: { id: a.id } });
    const none = await resolveAccess(db, {
      userId: user.id,
      appId: app.id,
      lastOrgId: null,
      orgId: null,
      adminClientId,
    });
    expect(none).toMatchObject({ ok: true, org: { id: a.id } });
  });

  it("reports no_app_access when nothing is eligible", async () => {
    const { app, user } = await world();
    expect(await resolveAccess(db, { userId: user.id, appId: app.id, adminClientId })).toEqual({
      ok: false,
      reason: "no_app_access",
    });
  });
});
