import { seedApp } from "../../../__tests__/fixtures.js";
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

async function appWithCatalog() {
  const app = await seedApp(h.db, {}, ["doc.item:view", "doc.item:edit", "doc.item:delete"]);
  return { app, base: `/apps/${app.id}/roles` };
}

describe("roles", () => {
  it("creates, lists, renames, sets permissions and deletes a role, one activity row each", async () => {
    const { app, base } = await appWithCatalog();
    const created = await h.call("POST", base, {
      name: "editor",
      description: "Edits",
      permissions: ["doc.item:view", "doc.item:edit", "doc.item:view"],
    });
    expect(created.statusCode).toBe(200);
    const role = created.json().data;
    expect(role).toMatchObject({
      appId: app.id,
      name: "editor",
      permissions: ["doc.item:edit", "doc.item:view"],
    });
    expect((await h.call("GET", base)).json().data).toHaveLength(1);

    const renamed = await h.call("PATCH", `${base}/${role.id}`, { name: "writer" });
    expect(renamed.json().data).toMatchObject({ name: "writer", description: "Edits" });

    const set = await h.call("PUT", `${base}/${role.id}/permissions`, {
      permissions: ["doc.item:delete"],
    });
    expect(set.json().data.permissions).toEqual(["doc.item:delete"]);
    expect(
      (await h.call("PUT", `${base}/${role.id}/permissions`, { permissions: [] })).json().data
        .permissions
    ).toEqual([]);

    expect((await h.call("DELETE", `${base}/${role.id}`)).statusCode).toBe(200);
    expect((await h.call("GET", base)).json().data).toEqual([]);

    for (const [action, n] of [
      ["admin.role.created", 1],
      ["admin.role.updated", 1],
      ["admin.role.permissions_set", 2],
      ["admin.role.deleted", 1],
    ] as const) {
      expect(await activityOf(h.db, action), action).toHaveLength(n);
    }
  });

  it("rejects platform:all on a role with 422, even on the admin app's catalog", async () => {
    const { base } = await appWithCatalog();
    expect(
      (await h.call("POST", base, { name: "x", permissions: ["platform:all"] })).statusCode
    ).toBe(422);
    await h.call("POST", `/apps/${h.adminApp.id}/permissions`, { permission: "platform:all" });
    const adminRole = await h.call("POST", `/apps/${h.adminApp.id}/roles`, {
      name: "super",
      permissions: ["platform:all"],
    });
    expect(adminRole.statusCode).toBe(422);
    const ok = (await h.call("POST", base, { name: "plain" })).json().data;
    const set = await h.call("PUT", `${base}/${ok.id}/permissions`, {
      permissions: ["platform:all"],
    });
    expect(set.statusCode).toBe(422);
  });

  it("rejects permissions missing from the catalog (422) and duplicate names (409)", async () => {
    const { base } = await appWithCatalog();
    const before = (await allActivity(h.db)).length;
    expect(
      (await h.call("POST", base, { name: "ghost", permissions: ["doc.item:nope"] })).statusCode
    ).toBe(422);
    const role = (await h.call("POST", base, { name: "dup" })).json().data;
    expect((await h.call("POST", base, { name: "dup" })).statusCode).toBe(409);
    const other = (await h.call("POST", base, { name: "other" })).json().data;
    expect((await h.call("PATCH", `${base}/${other.id}`, { name: "dup" })).statusCode).toBe(409);
    expect((await h.call("PATCH", `${base}/${role.id}`, { name: "dup" })).statusCode).toBe(200);
    expect(
      (await h.call("PUT", `${base}/${role.id}/permissions`, { permissions: ["doc.item:nope"] }))
        .statusCode
    ).toBe(422);
    // two creations + one same-name rename
    expect((await allActivity(h.db)).length).toBe(before + 3);
  });

  it("answers 422 for invalid input and 404 for unknown app or role", async () => {
    const { app, base } = await appWithCatalog();
    expect((await h.call("POST", base, { name: "" })).statusCode).toBe(422);
    expect((await h.call("PATCH", `${base}/${MISSING_ID}`, {})).statusCode).toBe(422);
    expect((await h.call("GET", `/apps/${MISSING_ID}/roles`)).statusCode).toBe(404);
    expect((await h.call("POST", `/apps/${MISSING_ID}/roles`, { name: "a" })).statusCode).toBe(404);
    expect((await h.call("PATCH", `${base}/${MISSING_ID}`, { name: "a" })).statusCode).toBe(404);
    expect((await h.call("DELETE", `${base}/${MISSING_ID}`)).statusCode).toBe(404);
    expect(
      (await h.call("PUT", `${base}/${MISSING_ID}/permissions`, { permissions: [] })).statusCode
    ).toBe(404);
    // A role of another app is not reachable through this app.
    const otherApp = await seedApp(h.db);
    const foreign = (await h.call("POST", `/apps/${otherApp.id}/roles`, { name: "f" })).json().data;
    expect((await h.call("DELETE", `/apps/${app.id}/roles/${foreign.id}`)).statusCode).toBe(404);
  });
});
