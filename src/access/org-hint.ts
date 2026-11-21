import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { organizations } from "../db/schema/index.js";

/** `org_hint` names an org by id or by slug (one deployment = one client, configured by slug). */
export const matchesOrgHint = (org: { id: string; slug: string }, hint: unknown): boolean =>
  typeof hint === "string" && hint !== "" && (org.id === hint || org.slug === hint);

/** Whether `hint` names the org `orgId` (looked up for its slug). */
export async function hintNamesOrg(db: Db, orgId: string, hint: unknown): Promise<boolean> {
  if (typeof hint !== "string" || hint === "") return false;
  if (hint === orgId) return true;
  const [row] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row?.slug === hint;
}
