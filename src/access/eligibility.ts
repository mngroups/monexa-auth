import { and, asc, eq, exists, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apps, memberships, orgApps, organizations, users } from "../db/schema/index.js";

export interface AccessOptions {
  /** `client_id` of the admin app (env ADMIN_CLIENT_ID). */
  adminClientId: string;
}

/** True when the user is a platform admin and `appId` is the admin app. */
export async function isPlatformAdminOnAdminApp(
  db: Db,
  userId: string,
  appId: string,
  { adminClientId }: AccessOptions
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(users)
    .innerJoin(apps, eq(apps.id, appId))
    .where(
      and(eq(users.id, userId), eq(users.isPlatformAdmin, true), eq(apps.clientId, adminClientId))
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Orgs the user may sign in to for this app, ordered by name: active memberships in
 * active orgs with the app enabled; platform admins get every active org on the admin app.
 */
export async function eligibleOrgs(
  db: Db,
  userId: string,
  appId: string,
  opts: AccessOptions
): Promise<{ id: string; name: string }[]> {
  const asAdmin = await isPlatformAdminOnAdminApp(db, userId, appId, opts);
  const viaMembership = and(
    exists(
      db
        .select({ one: sql`1` })
        .from(memberships)
        .where(
          and(
            eq(memberships.orgId, organizations.id),
            eq(memberships.userId, userId),
            eq(memberships.isActive, true)
          )
        )
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(orgApps)
        .where(and(eq(orgApps.orgId, organizations.id), eq(orgApps.appId, appId)))
    )
  );
  return db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(and(eq(organizations.isActive, true), asAdmin ? undefined : or(viaMembership)))
    .orderBy(asc(organizations.name));
}
