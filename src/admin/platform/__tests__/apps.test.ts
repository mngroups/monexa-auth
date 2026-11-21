import { eq } from "drizzle-orm";
import { seedApp, seedRole } from "../../../__tests__/fixtures.js";
import { apps, rolePermissions } from "../../../db/schema/index.js";
import { decryptSecret } from "../../../oidc/secrets.js";
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

const newApp = (clientId: string, extra: object = {}) =>
  h.call("POST", "/apps", { clientId, name: `App ${clientId}`, ...extra });

describe("apps", () => {
  it("creates an app returning the secret once; it is encrypted at rest and never shown again", async () => {
    const res = await newApp("billing", {
      redirectUris: ["https://billing.example.com/cb"],
      allowedGrants: ["authorization_code", "password"],
    });
    expect(res.statusCode).toBe(200);
    const created = res.json().data;
    expect(created).toMatchObject({
      clientId: "billing",
      redirectUris: ["https://billing.example.com/cb"],
      allowedGrants: ["authorization_code", "password"],
      accessTtlSeconds: 600,
      refreshTtlSeconds: 604_800,
      isActive: true,
    });
    const secret: string = created.clientSecret;
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await h.db.select().from(apps).where(eq(apps.id, created.id));
    expect(row?.clientSecretEnc).not.toContain(secret);
    const key = Buffer.from(h.env.CLIENT_SECRET_KEY, "base64");
    expect(decryptSecret(row?.clientSecretEnc ?? "", key)).toBe(secret);

    const get = await h.call("GET", `/apps/${created.id}`);
    const list = await h.call("GET", "/apps?q=billing");
    for (const body of [get.body, list.body]) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain("clientSecret");
      expect(body).not.toContain("client_secret_enc");
      expect(body).not.toContain(row?.clientSecretEnc ?? "never");
    }
    expect(list.json().data.items).toHaveLength(1);

    const rows = await activityOf(h.db, "admin.app.created");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(rows[0]?.metadata).toEqual({ clientId: "billing", name: "App billing" });
  });

  it("rotates the secret: returned once, replaces the stored one, not in the activity row", async () => {
    const created = (await newApp("rotate-me")).json().data;
    const res = await h.call("POST", `/apps/${created.id}/rotate-secret`);
    expect(res.statusCode).toBe(200);
    const next: string = res.json().data.clientSecret;
    expect(next).not.toBe(created.clientSecret);
    const [row] = await h.db.select().from(apps).where(eq(apps.id, created.id));
    const key = Buffer.from(h.env.CLIENT_SECRET_KEY, "base64");
    expect(decryptSecret(row?.clientSecretEnc ?? "", key)).toBe(next);
    expect((await h.call("GET", `/apps/${created.id}`)).body).not.toContain(next);
    const rows = await activityOf(h.db, "admin.app.secret_rotated");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(next);
    expect(JSON.stringify(rows[0])).not.toContain(created.clientSecret);
  });

  it("updates and toggles an app with one activity row each", async () => {
    const created = (await newApp("editable")).json().data;
    const patched = await h.call("PATCH", `/apps/${created.id}`, {
      name: "Renamed",
      accessTtlSeconds: 900,
      postLogoutRedirectUris: ["https://x.example.com/bye"],
    });
    expect(patched.json().data).toMatchObject({ name: "Renamed", accessTtlSeconds: 900 });
    expect((await h.call("POST", `/apps/${created.id}/deactivate`)).json().data.isActive).toBe(
      false
    );
    expect((await h.call("POST", `/apps/${created.id}/activate`)).json().data.isActive).toBe(true);
    const updated = (await activityOf(h.db, "admin.app.updated")).filter(
      (r) => r.targetId === created.id
    );
    expect(updated).toHaveLength(1);
    expect([...((updated[0]?.metadata.fields as string[] | undefined) ?? [])].sort()).toEqual([
      "accessTtlSeconds",
      "name",
      "postLogoutRedirectUris",
    ]);
    for (const action of ["admin.app.deactivated", "admin.app.activated"]) {
      expect(
        (await activityOf(h.db, action)).filter((r) => r.targetId === created.id)
      ).toHaveLength(1);
    }
  });

  it("answers 422 for invalid input, 409 for a taken client id, 404 for unknown apps; no activity on failure", async () => {
    const before = (await allActivity(h.db)).length;
    await newApp("dup");
    const afterFirst = (await allActivity(h.db)).length;
    expect(afterFirst).toBe(before + 1);
    expect((await newApp("dup")).statusCode).toBe(409);
    expect((await newApp("X")).statusCode).toBe(422);
    expect((await newApp("bad-uri", { redirectUris: ["javascript:alert(1)"] })).statusCode).toBe(
      422
    );
    expect((await newApp("bad-grant", { allowedGrants: ["implicit"] })).statusCode).toBe(422);
    expect((await newApp("no-grant", { allowedGrants: [] })).statusCode).toBe(422);
    expect((await newApp("bad-ttl", { accessTtlSeconds: 1 })).statusCode).toBe(422);
    expect((await h.call("PATCH", `/apps/${MISSING_ID}`, {})).statusCode).toBe(422);
    expect((await h.call("PATCH", `/apps/${MISSING_ID}`, { name: "x" })).statusCode).toBe(404);
    expect((await h.call("GET", `/apps/${MISSING_ID}`)).statusCode).toBe(404);
    expect((await h.call("POST", `/apps/${MISSING_ID}/rotate-secret`)).statusCode).toBe(404);
    expect((await h.call("POST", `/apps/${MISSING_ID}/activate`)).statusCode).toBe(404);
    expect((await allActivity(h.db)).length).toBe(afterFirst);
  });
});

describe("app permissions", () => {
  it("adds, lists and removes catalog permissions; removing also drops them from roles", async () => {
    const app = await seedApp(h.db);
    const base = `/apps/${app.id}/permissions`;
    const add = await h.call("POST", base, { permission: "invoice.item:view", description: "See" });
    expect(add.statusCode).toBe(200);
    await h.call("POST", base, { permission: "invoice.item:edit" });
    expect((await h.call("GET", base)).json().data).toEqual([
      { permission: "invoice.item:edit", description: "" },
      { permission: "invoice.item:view", description: "See" },
    ]);

    const role = await seedRole(h.db, app.id, "clerk", ["invoice.item:view", "invoice.item:edit"]);
    const otherApp = await seedApp(h.db);
    const otherRole = await seedRole(h.db, otherApp.id, "other", ["invoice.item:view"]);

    const del = await h.call("DELETE", `${base}/invoice.item:view`);
    expect(del.statusCode).toBe(200);
    const left = await h.db.select().from(rolePermissions);
    expect(left.filter((r) => r.roleId === role.id).map((r) => r.permission)).toEqual([
      "invoice.item:edit",
    ]);
    expect(left.filter((r) => r.roleId === otherRole.id)).toHaveLength(1);
    expect((await h.call("GET", base)).json().data).toHaveLength(1);

    expect(await activityOf(h.db, "admin.app_permission.added")).toHaveLength(2);
    const removed = await activityOf(h.db, "admin.app_permission.removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]?.metadata).toEqual({ appId: app.id, permission: "invoice.item:view" });
  });

  it("allows platform:* only on the admin app", async () => {
    const plain = await seedApp(h.db);
    const res = await h.call("POST", `/apps/${plain.id}/permissions`, {
      permission: "platform:all",
    });
    expect(res.statusCode).toBe(422);
    const ok = await h.call("POST", `/apps/${h.adminApp.id}/permissions`, {
      permission: "platform:all",
    });
    expect(ok.statusCode).toBe(200);
  });

  it("answers 422 for a malformed permission, 409 for a duplicate, 404 for unknown app/permission", async () => {
    const app = await seedApp(h.db);
    const base = `/apps/${app.id}/permissions`;
    expect((await h.call("POST", base, { permission: "nocolon" })).statusCode).toBe(422);
    expect((await h.call("POST", base, { permission: "Bad:Case" })).statusCode).toBe(422);
    await h.call("POST", base, { permission: "a.b:c" });
    expect((await h.call("POST", base, { permission: "a.b:c" })).statusCode).toBe(409);
    expect((await h.call("DELETE", `${base}/a.b:zzz`)).statusCode).toBe(404);
    expect((await h.call("GET", `/apps/${MISSING_ID}/permissions`)).statusCode).toBe(404);
    expect(
      (await h.call("POST", `/apps/${MISSING_ID}/permissions`, { permission: "a:b" })).statusCode
    ).toBe(404);
    expect((await h.call("DELETE", `/apps/${MISSING_ID}/permissions/a:b`)).statusCode).toBe(404);
    const added = await activityOf(h.db, "admin.app_permission.added");
    expect(added.filter((r) => r.metadata.appId === app.id)).toHaveLength(1);
  });
});
