import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
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
} from "../db/schema/index.js";
import { encryptSecret } from "../oidc/secrets.js";

let counter = 0;
const next = () => `${++counter}`;

export async function seedUser(
  db: Db,
  v: Partial<typeof users.$inferInsert> = {}
): Promise<typeof users.$inferSelect> {
  const n = next();
  const [row] = await db
    .insert(users)
    .values({ email: `user${n}@example.com`, name: `User ${n}`, ...v })
    .returning();
  return row as typeof users.$inferSelect;
}

export async function seedOrg(db: Db, v: Partial<typeof organizations.$inferInsert> = {}) {
  const n = next();
  const [row] = await db
    .insert(organizations)
    .values({ slug: `org-${n}`, name: `Org ${n}`, ...v })
    .returning();
  return row as typeof organizations.$inferSelect;
}

export async function seedApp(
  db: Db,
  v: Partial<typeof apps.$inferInsert> = {},
  permissions: string[] = []
) {
  const n = next();
  const [row] = await db
    .insert(apps)
    .values({ clientId: `app-${n}`, name: `App ${n}`, clientSecretEnc: "enc", ...v })
    .returning();
  const app = row as typeof apps.$inferSelect;
  if (permissions.length > 0) {
    await db
      .insert(appPermissions)
      .values(permissions.map((permission) => ({ appId: app.id, permission })));
  }
  return app;
}

export async function seedRole(db: Db, appId: string, name: string, permissions: string[] = []) {
  const [row] = await db.insert(roles).values({ appId, name }).returning();
  const role = row as typeof roles.$inferSelect;
  if (permissions.length > 0) {
    await db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role.id, permission })));
  }
  return role;
}

export async function addMember(db: Db, userId: string, orgId: string, isActive = true) {
  await db.insert(memberships).values({ userId, orgId, isActive });
}

export async function assignRole(db: Db, userId: string, orgId: string, roleId: string) {
  await db.insert(memberRoles).values({ userId, orgId, roleId });
}

export async function enableApp(db: Db, orgId: string, appId: string) {
  await db.insert(orgApps).values({ orgId, appId });
}

export async function getUser(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id)));
  return row as typeof users.$inferSelect;
}

/** An app with a real encrypted secret, as the provider's Client adapter reads it. */
export async function seedClient(
  db: Db,
  key: Buffer,
  v: Partial<typeof apps.$inferInsert> = {},
  permissions: string[] = []
) {
  const secret = `secret-${next()}`;
  const app = await seedApp(db, { clientSecretEnc: encryptSecret(secret, key), ...v }, permissions);
  return { app, secret };
}
