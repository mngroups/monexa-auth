import { and, eq, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { organizations, orgLogos } from "../db/schema/index.js";

export type Brand = { slug: string; name: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The org a login page is branded with: the `org_hint` (id or slug) of an **active** org that
 * has a logo. Independent of the user: it runs before sign-in, and the logo is public anyway.
 */
export async function resolveBrand(db: Db, hint: unknown): Promise<Brand | null> {
  if (typeof hint !== "string" || hint === "" || hint.length > 100) return null;
  const byHint = UUID.test(hint)
    ? or(eq(organizations.id, hint), eq(organizations.slug, hint))
    : eq(organizations.slug, hint);
  const [row] = await db
    .select({ slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .innerJoin(orgLogos, eq(orgLogos.orgId, organizations.id))
    .where(and(byHint, eq(organizations.isActive, true)));
  return row ?? null;
}
