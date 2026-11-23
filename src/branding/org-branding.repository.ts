import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { organizations } from "../db/schema/index.js";

/** An org's slug and name, for its public branding; undefined when the org is unknown. */
export async function findOrgBranding(
  db: Db,
  orgId: string
): Promise<{ slug: string; name: string } | undefined> {
  const [row] = await db
    .select({ slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row;
}
