import { and, asc, count, eq, ilike, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { apps, type OrganizationRow, orgApps, organizations } from "../../db/schema/index.js";
import { containsPattern, type PageQuery, paging } from "./common.js";

export async function listOrgs(db: Db, q: PageQuery & { q?: string }) {
  const where = q.q
    ? or(
        ilike(organizations.name, containsPattern(q.q)),
        ilike(organizations.slug, containsPattern(q.q))
      )
    : undefined;
  const items = await db
    .select()
    .from(organizations)
    .where(where)
    .orderBy(asc(organizations.name), asc(organizations.id))
    .limit(paging(q).limit)
    .offset(paging(q).offset);
  const [row] = await db.select({ total: count() }).from(organizations).where(where);
  return { items, total: row?.total ?? 0 };
}

export async function findOrg(db: Db, id: string): Promise<OrganizationRow | undefined> {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, id));
  return row;
}

export async function insertOrg(db: Db, v: { slug: string; name: string }) {
  const [row] = await db.insert(organizations).values(v).returning();
  return row as OrganizationRow;
}

export async function updateOrg(
  db: Db,
  id: string,
  v: Partial<{ slug: string; name: string; isActive: boolean }>
) {
  const [row] = await db
    .update(organizations)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(organizations.id, id))
    .returning();
  return row;
}

export async function appExists(db: Db, appId: string): Promise<boolean> {
  const [row] = await db.select({ id: apps.id }).from(apps).where(eq(apps.id, appId));
  return Boolean(row);
}

export async function enableOrgApp(db: Db, orgId: string, appId: string): Promise<void> {
  await db.insert(orgApps).values({ orgId, appId }).onConflictDoNothing();
}

export async function disableOrgApp(db: Db, orgId: string, appId: string): Promise<boolean> {
  const removed = await db
    .delete(orgApps)
    .where(and(eq(orgApps.orgId, orgId), eq(orgApps.appId, appId)))
    .returning({ appId: orgApps.appId });
  return removed.length > 0;
}
