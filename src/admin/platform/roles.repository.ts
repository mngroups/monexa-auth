import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { rolePermissions, roles } from "../../db/schema/index.js";

type RoleRow = typeof roles.$inferSelect;
export type RoleWithPermissions = RoleRow & { permissions: string[] };

async function permissionsOf(db: Db, roleId: string): Promise<string[]> {
  const rows = await db
    .select({ permission: rolePermissions.permission })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId))
    .orderBy(asc(rolePermissions.permission));
  return rows.map((r) => r.permission);
}

export async function listRoles(db: Db, appId: string): Promise<RoleWithPermissions[]> {
  const rows = await db
    .select()
    .from(roles)
    .where(eq(roles.appId, appId))
    .orderBy(asc(roles.name), asc(roles.id));
  return Promise.all(rows.map(async (r) => ({ ...r, permissions: await permissionsOf(db, r.id) })));
}

export async function findRole(
  db: Db,
  appId: string,
  roleId: string
): Promise<RoleWithPermissions | undefined> {
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.appId, appId)));
  return row ? { ...row, permissions: await permissionsOf(db, row.id) } : undefined;
}

export async function roleNameTaken(db: Db, appId: string, name: string, exceptId?: string) {
  const rows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.appId, appId), eq(roles.name, name)));
  return rows.some((r) => r.id !== exceptId);
}

export async function insertRole(
  db: Db,
  v: { appId: string; name: string; description: string }
): Promise<RoleRow> {
  const [row] = await db.insert(roles).values(v).returning();
  return row as RoleRow;
}

export async function updateRole(
  db: Db,
  roleId: string,
  v: Partial<{ name: string; description: string }>
) {
  await db.update(roles).set(v).where(eq(roles.id, roleId));
}

export async function deleteRole(db: Db, roleId: string) {
  await db.delete(roles).where(eq(roles.id, roleId));
}

export async function setRolePermissions(db: Db, roleId: string, permissions: string[]) {
  await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  if (permissions.length > 0) {
    await db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId, permission })));
  }
}
