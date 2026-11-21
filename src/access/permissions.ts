import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { appPermissions, memberRoles, rolePermissions, roles } from "../db/schema/index.js";
import { isPlatformPermission } from "../permissions.js";
import { type AccessOptions, eligibleOrgs, isPlatformAdminOnAdminApp } from "./eligibility.js";

export type AccessResult =
  | { ok: true; org: { id: string; name: string }; permissions: string[] }
  | { ok: false; reason: "no_app_access" | "org_not_eligible" };

/**
 * Chooses the org (explicit, else last used, else first eligible) and computes the token
 * permissions: role permissions for this app and org, limited to the app's catalog.
 * `platform:*` / `platform.x:*` from roles are dropped; `platform:all` is added only for platform admins on the admin app.
 */
export async function resolveAccess(
  db: Db,
  p: {
    userId: string;
    appId: string;
    orgId?: string | null;
    lastOrgId?: string | null;
  } & AccessOptions
): Promise<AccessResult> {
  const orgs = await eligibleOrgs(db, p.userId, p.appId, p);
  const first = orgs[0];
  if (!first) return { ok: false, reason: "no_app_access" };

  let picked: { id: string; name: string };
  if (p.orgId) {
    const chosen = orgs.find((o) => o.id === p.orgId);
    if (!chosen) return { ok: false, reason: "org_not_eligible" };
    picked = chosen;
  } else {
    picked = orgs.find((o) => o.id === p.lastOrgId) ?? first;
  }
  const org = { id: picked.id, name: picked.name };

  const rows = await db
    .selectDistinct({ permission: rolePermissions.permission })
    .from(memberRoles)
    .innerJoin(roles, and(eq(roles.id, memberRoles.roleId), eq(roles.appId, p.appId)))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(
      appPermissions,
      and(
        eq(appPermissions.appId, p.appId),
        eq(appPermissions.permission, rolePermissions.permission)
      )
    )
    .where(and(eq(memberRoles.userId, p.userId), eq(memberRoles.orgId, org.id)));

  const permissions = rows.map((r) => r.permission).filter((s) => !isPlatformPermission(s));
  if (await isPlatformAdminOnAdminApp(db, p.userId, p.appId, p)) permissions.push("platform:all");
  return { ok: true, org, permissions: permissions.sort() };
}
