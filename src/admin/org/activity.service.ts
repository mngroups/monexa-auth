import type { Db } from "../../db/client.js";
import { listActivity as listAll } from "../platform/activity.service.js";
import type { PageQuery } from "../platform/common.js";

/** The org's own rows only: the org filter comes from the token, never from the query. */
export function listOrgActivity(
  db: Db,
  orgId: string,
  q: PageQuery & { action?: string; from?: Date; to?: Date }
) {
  return listAll(db, { ...q, orgId });
}
