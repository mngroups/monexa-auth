import { eq, getTableName, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { createTestDb } from "../../__tests__/db.js";
import type { Db } from "../client.js";
import {
  appPermissions,
  apps,
  memberRoles,
  memberships,
  orgApps,
  organizations,
  rolePermissions,
  roles,
  users,
} from "../schema/index.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});
afterEach(() => close());

const user = (over: Partial<typeof users.$inferInsert> = {}) => ({
  email: "budi@example.com",
  name: "Budi",
  ...over,
});

async function seedOrg() {
  const [org] = await db.insert(organizations).values({ slug: "acme", name: "Acme" }).returning();
  const [u] = await db.insert(users).values(user()).returning();
  const [app] = await db
    .insert(apps)
    .values({ clientId: "monexa-app", name: "App", clientSecretEnc: "enc" })
    .returning();
  const [role] = await db
    .insert(roles)
    .values({ appId: app?.id as string, name: "Viewer" })
    .returning();
  return { org: org!, u: u!, app: app!, role: role! };
}

describe("schema + migrations", () => {
  it("applies column defaults to a new user", async () => {
    const [row] = await db.insert(users).values(user()).returning();
    expect(row).toMatchObject({
      mustChangePassword: false,
      isActive: true,
      isPlatformAdmin: false,
      failedLogins: 0,
      lockedUntil: null,
      passwordHash: null,
      username: null,
    });
  });

  it("rejects two users whose emails differ only by case", async () => {
    await db.insert(users).values(user());
    await expect(db.insert(users).values(user({ email: "BUDI@Example.com" }))).rejects.toThrow();
  });

  it("matches emails case-insensitively", async () => {
    await db.insert(users).values(user());
    const rows = await db.select().from(users).where(eq(users.email, "Budi@EXAMPLE.com"));
    expect(rows).toHaveLength(1);
  });

  it("rejects usernames that differ only by case, but allows many null usernames", async () => {
    await db.insert(users).values(user({ username: "Budi" }));
    await expect(
      db.insert(users).values(user({ email: "b2@example.com", username: "budi" }))
    ).rejects.toThrow();
    await db.insert(users).values(user({ email: "n1@example.com" }));
    await db.insert(users).values(user({ email: "n2@example.com" }));
  });

  it("defaults a membership to active", async () => {
    const { org, u } = await seedOrg();
    const [m] = await db.insert(memberships).values({ userId: u.id, orgId: org.id }).returning();
    expect(m?.isActive).toBe(true);
  });

  it("defaults an app's grants and TTLs", async () => {
    const { app } = await seedOrg();
    expect(app).toMatchObject({
      allowedGrants: ["authorization_code"],
      redirectUris: [],
      accessTtlSeconds: 600,
      refreshTtlSeconds: 604800,
      isActive: true,
    });
  });

  it("rejects an unknown grant type", async () => {
    await expect(
      db.insert(apps).values({
        clientId: "x",
        name: "x",
        clientSecretEnc: "e",
        allowedGrants: ["implicit" as "password"],
      })
    ).rejects.toThrow();
  });

  it("cascades an org's memberships, org_apps and member_roles on delete", async () => {
    const { org, u, app, role } = await seedOrg();
    await db.insert(memberships).values({ userId: u.id, orgId: org.id });
    await db.insert(orgApps).values({ orgId: org.id, appId: app.id });
    await db.insert(memberRoles).values({ userId: u.id, orgId: org.id, roleId: role.id });
    await db.delete(organizations).where(eq(organizations.id, org.id));
    expect(await db.select().from(memberships)).toEqual([]);
    expect(await db.select().from(orgApps)).toEqual([]);
    expect(await db.select().from(memberRoles)).toEqual([]);
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("cascades an app's permissions and roles on delete", async () => {
    const { app } = await seedOrg();
    await db.insert(appPermissions).values({ appId: app.id, permission: "a.b:view" });
    await db.delete(apps).where(eq(apps.id, app.id));
    expect(await db.select().from(appPermissions)).toEqual([]);
    expect(await db.select().from(roles)).toEqual([]);
  });
});

describe("oidc_store", () => {
  it("indexes grant, uid, expiry, user and org lookups", async () => {
    const { rows } = await (
      db as unknown as { execute: (q: unknown) => Promise<{ rows: { indexname: string }[] }> }
    ).execute(sql`select indexname from pg_indexes where tablename = 'oidc_store'`);
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      "oidc_store_expires_at_idx",
      "oidc_store_kind_grant_id_idx",
      "oidc_store_kind_id_pk",
      "oidc_store_kind_uid_idx",
      "oidc_store_org_id_idx",
      "oidc_store_user_id_idx",
    ]);
  });
});

describe("foreign keys", () => {
  it("all cascade on delete", () => {
    const tables = [memberships, appPermissions, roles, rolePermissions, orgApps, memberRoles];
    for (const table of tables) {
      const { foreignKeys } = getTableConfig(table);
      expect(foreignKeys.length, getTableName(table)).toBeGreaterThan(0);
      for (const fk of foreignKeys) {
        expect(
          fk.onDelete,
          `${getTableName(table)} -> ${getTableName(fk.reference().foreignTable)}`
        ).toBe("cascade");
      }
    }
  });
});
