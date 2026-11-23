import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { apps, memberRoles, orgApps, roles } from "../../db/schema/index.js";

/** The given roles that exist, with whether their app is enabled for the org. */
export async function rolesWithEnablement(db: Db, orgId: string, roleIds: string[]) {
  if (roleIds.length === 0) return [];
  const rows = await db
    .select({ id: roles.id, enabledAppId: orgApps.appId })
    .from(roles)
    .leftJoin(orgApps, and(eq(orgApps.appId, roles.appId), eq(orgApps.orgId, orgId)))
    .where(inArray(roles.id, roleIds));
  return rows.map((r) => ({ id: r.id, enabled: r.enabledAppId !== null }));
}

export async function insertMemberRoles(db: Db, orgId: string, userId: string, roleIds: string[]) {
  if (roleIds.length === 0) return;
  await db.insert(memberRoles).values(roleIds.map((roleId) => ({ orgId, userId, roleId })));
}

/** Roles of every app enabled for the org, by app name then role name. */
export function orgRoles(db: Db, orgId: string) {
  return db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      appId: roles.appId,
      appName: apps.name,
    })
    .from(roles)
    .innerJoin(apps, eq(apps.id, roles.appId))
    .innerJoin(orgApps, and(eq(orgApps.appId, roles.appId), eq(orgApps.orgId, orgId)))
    .orderBy(asc(apps.name), asc(roles.name), asc(roles.id));
}
