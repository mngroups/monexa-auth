import type { Db } from "../../db/client.js";
import { type ActivityFilter, listActivity as query } from "./activity.repository.js";
import { iso } from "./common.js";

export async function listActivity(db: Db, f: ActivityFilter) {
  const { items, total } = await query(db, f);
  return {
    items: items.map((a) => ({ ...a, at: iso(a.at) })),
    page: f.page,
    pageSize: f.pageSize,
    total,
  };
}
