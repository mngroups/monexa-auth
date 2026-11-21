import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { appPermissions, rolePermissions, roles } from "../../db/schema/index.js";

export function listPermissions(db: Db, appId: string) {
  return db
    .select({ permission: appPermissions.permission, description: appPermissions.description })
    .from(appPermissions)
    .where(eq(appPermissions.appId, appId))
    .orderBy(asc(appPermissions.permission));
}

export async function insertPermission(
  db: Db,
  v: { appId: string; permission: string; description: string }
) {
  const [row] = await db
    .insert(appPermissions)
    .values(v)
    .returning({ permission: appPermissions.permission, description: appPermissions.description });
  return row as { permission: string; description: string };
}

/** Removes a catalog entry and every role grant of it within the app. */
export async function deletePermission(db: Db, appId: string, permission: string) {
  await db
    .delete(rolePermissions)
    .where(
      and(
        eq(rolePermissions.permission, permission),
        inArray(
          rolePermissions.roleId,
          db.select({ id: roles.id }).from(roles).where(eq(roles.appId, appId))
        )
      )
    );
  const removed = await db
    .delete(appPermissions)
    .where(and(eq(appPermissions.appId, appId), eq(appPermissions.permission, permission)))
    .returning({ permission: appPermissions.permission });
  return removed.length > 0;
}

/** Which of `permissions` are in the app's catalog. */
export async function inCatalog(
  db: Db,
  appId: string,
  permissions: string[]
): Promise<Set<string>> {
  if (permissions.length === 0) return new Set();
  const rows = await db
    .select({ permission: appPermissions.permission })
    .from(appPermissions)
    .where(and(eq(appPermissions.appId, appId), inArray(appPermissions.permission, permissions)));
  return new Set(rows.map((r) => r.permission));
}
