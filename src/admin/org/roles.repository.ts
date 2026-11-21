import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { memberRoles, orgApps, roles } from "../../db/schema/index.js";

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
