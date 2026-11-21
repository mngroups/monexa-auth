import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { activityLog } from "../../db/schema/index.js";
import { type PageQuery, paging } from "./common.js";

export type ActivityFilter = PageQuery & {
  orgId?: string;
  action?: string;
  from?: Date;
  to?: Date;
};

export async function listActivity(db: Db, f: ActivityFilter) {
  const filters: SQL[] = [];
  if (f.orgId) filters.push(eq(activityLog.orgId, f.orgId));
  if (f.action) filters.push(eq(activityLog.action, f.action));
  if (f.from) filters.push(gte(activityLog.at, f.from));
  if (f.to) filters.push(lte(activityLog.at, f.to));
  const where = filters.length > 0 ? and(...filters) : undefined;
  const items = await db
    .select()
    .from(activityLog)
    .where(where)
    .orderBy(desc(activityLog.at), desc(activityLog.id))
    .limit(paging(f).limit)
    .offset(paging(f).offset);
  const [row] = await db.select({ total: count() }).from(activityLog).where(where);
  return { items, total: row?.total ?? 0 };
}
