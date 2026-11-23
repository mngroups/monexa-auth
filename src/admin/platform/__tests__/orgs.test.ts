import { eq } from "drizzle-orm";
import { seedApp, seedOrg, seedUser } from "../../../__tests__/fixtures.js";
import { apps, oidcStore } from "../../../db/schema/index.js";
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

describe("orgs", () => {
  it("creates, lists/searches, updates, deactivates and activates, one activity row each", async () => {
    const created = await h.call("POST", "/orgs", { slug: "acme-co", name: "Acme Co" });
    expect(created.statusCode).toBe(200);
    const org = created.json().data;
    expect(org).toMatchObject({ slug: "acme-co", name: "Acme Co", isActive: true });

    const found = await h.call("GET", "/orgs?q=acme");
    expect(found.json().data).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(found.json().data.items[0].id).toBe(org.id);
    await seedOrg(h.db, { name: "100% Org" });
    expect((await h.call("GET", "/orgs?q=%25")).json().data.total).toBe(1);
    expect((await h.call("GET", "/orgs?pageSize=1&page=2")).json().data.items).toHaveLength(1);

    const patched = await h.call("PATCH", `/orgs/${org.id}`, { name: "Acme Inc" });
    expect(patched.json().data.name).toBe("Acme Inc");
    expect((await h.call("POST", `/orgs/${org.id}/deactivate`)).json().data.isActive).toBe(false);
    expect((await h.call("POST", `/orgs/${org.id}/activate`)).json().data.isActive).toBe(true);

    for (const action of [
      "admin.org.created",
      "admin.org.updated",
      "admin.org.deactivated",
      "admin.org.activated",
    ]) {
      const rows = await activityOf(h.db, action);
      expect(rows, action).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: h.user.id, orgId: org.id, targetId: org.id });
    }
  });

  it("answers 422 for invalid input, 409 for a taken slug and 404 for unknown orgs, without activity", async () => {
    const before = (await allActivity(h.db)).length;
    expect((await h.call("POST", "/orgs", { slug: "Bad Slug", name: "x" })).statusCode).toBe(422);
    expect((await h.call("POST", "/orgs", { slug: "ok" })).statusCode).toBe(422);
    expect((await h.call("PATCH", `/orgs/${MISSING_ID}`, {})).statusCode).toBe(422);
    expect((await h.call("GET", "/orgs?page=0")).statusCode).toBe(422);
    expect((await h.call("PATCH", "/orgs/not-a-uuid", { name: "x" })).statusCode).toBe(422);
    const taken = await seedOrg(h.db, { slug: "taken" });
    expect((await h.call("POST", "/orgs", { slug: "taken", name: "Dup" })).statusCode).toBe(409);
    expect((await h.call("PATCH", `/orgs/${MISSING_ID}`, { name: "x" })).statusCode).toBe(404);
    expect((await h.call("POST", `/orgs/${MISSING_ID}/activate`)).statusCode).toBe(404);
    expect((await h.call("POST", `/orgs/${MISSING_ID}/deactivate`)).statusCode).toBe(404);
    const other = (await h.call("POST", "/orgs", { slug: "other", name: "Other" })).json().data;
    expect((await h.call("PATCH", `/orgs/${other.id}`, { slug: taken.slug })).statusCode).toBe(409);
    expect((await allActivity(h.db)).length).toBe(before + 1);
  });
});

describe("org apps", () => {
  it("enables an app (idempotent), then disables it and revokes that org+app grants only", async () => {
    const org = await seedOrg(h.db);
    const otherOrg = await seedOrg(h.db);
    const app = await seedApp(h.db);
    const user = await seedUser(h.db);
    const grant = (id: string, orgId: string) =>
      h.db.insert(oidcStore).values({
        id,
        kind: "Grant",
        payload: { clientId: app.clientId },
        userId: user.id,
        orgId,
      });
    await grant(`g-${org.id}`, org.id);
    await grant(`g-${otherOrg.id}`, otherOrg.id);

    const url = `/orgs/${org.id}/apps/${app.id}`;
    expect((await h.call("PUT", url)).json().data).toEqual({
      orgId: org.id,
      appId: app.id,
      enabled: true,
      revokedGrants: 0,
    });
    expect((await h.call("PUT", url)).statusCode).toBe(200);
    expect(await activityOf(h.db, "admin.org_app.enabled")).toHaveLength(2);

    const off = await h.call("DELETE", url);
    expect(off.json().data).toMatchObject({ enabled: false, revokedGrants: 1 });
    const left = await h.db
      .select({ id: oidcStore.id })
      .from(oidcStore)
      .where(eq(oidcStore.userId, user.id));
    expect(left.map((r) => r.id)).toEqual([`g-${otherOrg.id}`]);
    const rows = await activityOf(h.db, "admin.org_app.disabled");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ appId: app.id, revokedGrants: 1 });

    expect((await h.call("DELETE", url)).statusCode).toBe(404);
    expect(await activityOf(h.db, "admin.org_app.disabled")).toHaveLength(1);
  });

  it("answers 404 for unknown org or app and 422 for a bad id", async () => {
    const org = await seedOrg(h.db);
    const app = await seedApp(h.db);
    expect((await h.call("PUT", `/orgs/${MISSING_ID}/apps/${app.id}`)).statusCode).toBe(404);
    expect((await h.call("PUT", `/orgs/${org.id}/apps/${MISSING_ID}`)).statusCode).toBe(404);
    expect((await h.call("DELETE", `/orgs/${MISSING_ID}/apps/${app.id}`)).statusCode).toBe(404);
    expect((await h.call("PUT", `/orgs/${org.id}/apps/nope`)).statusCode).toBe(422);
  });
});

describe("GET /orgs/:id/apps", () => {
  it("lists every app with whether the org has it", async () => {
    const org = await seedOrg(h.db);
    const probe = await seedApp(h.db, { name: "Zzz Probe", isActive: false });
    const second = await seedApp(h.db, { name: "Mmm Second", isActive: true });
    const third = await seedApp(h.db, { name: "Aaa Third", isActive: true });
    await h.call("PUT", `/orgs/${org.id}/apps/${second.id}`);

    const res = await h.call("GET", `/orgs/${org.id}/apps`);
    expect(res.statusCode).toBe(200);
    const items = res.json().data as {
      appId: string;
      clientId: string;
      name: string;
      isActive: boolean;
      enabled: boolean;
    }[];
    const allApps = await h.db.select().from(apps);
    expect(items).toHaveLength(allApps.length);
    expect(items.map((a) => a.appId).sort()).toEqual(allApps.map((a) => a.id).sort());

    const enabledById = new Map(items.map((a) => [a.appId, a.enabled]));
    expect(enabledById.get(h.adminApp.id)).toBe(false);
    expect(enabledById.get(probe.id)).toBe(false);
    expect(enabledById.get(second.id)).toBe(true);
    expect(enabledById.get(third.id)).toBe(false);
    expect(items.find((a) => a.appId === probe.id)).toEqual({
      appId: probe.id,
      clientId: probe.clientId,
      name: "Zzz Probe",
      isActive: false,
      enabled: false,
    });

    await h.call("PUT", `/orgs/${org.id}/apps/${probe.id}`);
    const after = (await h.call("GET", `/orgs/${org.id}/apps`)).json().data as {
      appId: string;
      enabled: boolean;
    }[];
    expect(after.find((a) => a.appId === probe.id)).toMatchObject({ enabled: true });
    expect(
      after
        .filter((a) => a.enabled)
        .map((a) => a.appId)
        .sort()
    ).toEqual([probe.id, second.id].sort());
    await h.call("DELETE", `/orgs/${org.id}/apps/${probe.id}`);
    const final = (await h.call("GET", `/orgs/${org.id}/apps`)).json().data as {
      appId: string;
      enabled: boolean;
    }[];
    expect(final.find((a) => a.appId === probe.id)).toMatchObject({ enabled: false });
  });

  it("answers 404 for an unknown org", async () => {
    expect((await h.call("GET", `/orgs/${MISSING_ID}/apps`)).statusCode).toBe(404);
  });
});
