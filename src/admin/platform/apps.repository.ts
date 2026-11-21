import { asc, count, eq, ilike, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { type AppRow, apps } from "../../db/schema/index.js";
import { containsPattern, type PageQuery, paging } from "./common.js";

export type AppValues = Partial<
  Pick<
    AppRow,
    | "name"
    | "redirectUris"
    | "postLogoutRedirectUris"
    | "allowedGrants"
    | "accessTtlSeconds"
    | "refreshTtlSeconds"
    | "isActive"
    | "clientSecretEnc"
  >
>;

export async function listApps(db: Db, q: PageQuery & { q?: string }) {
  const where = q.q
    ? or(ilike(apps.name, containsPattern(q.q)), ilike(apps.clientId, containsPattern(q.q)))
    : undefined;
  const items = await db
    .select()
    .from(apps)
    .where(where)
    .orderBy(asc(apps.name), asc(apps.id))
    .limit(paging(q).limit)
    .offset(paging(q).offset);
  const [row] = await db.select({ total: count() }).from(apps).where(where);
  return { items, total: row?.total ?? 0 };
}

export async function findApp(db: Db, id: string): Promise<AppRow | undefined> {
  const [row] = await db.select().from(apps).where(eq(apps.id, id));
  return row;
}

export async function insertApp(
  db: Db,
  v: AppValues & { clientId: string; name: string; clientSecretEnc: string }
) {
  const [row] = await db.insert(apps).values(v).returning();
  return row as AppRow;
}

export async function updateApp(db: Db, id: string, v: AppValues) {
  const [row] = await db
    .update(apps)
    .set({ ...v, updatedAt: new Date() })
    .where(eq(apps.id, id))
    .returning();
  return row;
}
