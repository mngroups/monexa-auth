import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { organizations, orgLogos } from "../db/schema/index.js";

export type LogoMeta = { etag: string; updatedAt: Date };

export async function upsertLogo(
  db: Db,
  v: { orgId: string; content: Buffer; mime: string; etag: string; updatedBy: string }
): Promise<LogoMeta> {
  const now = new Date();
  const values = { ...v, size: v.content.length, updatedAt: now };
  const [row] = await db
    .insert(orgLogos)
    .values(values)
    .onConflictDoUpdate({ target: orgLogos.orgId, set: values })
    .returning({ etag: orgLogos.etag, updatedAt: orgLogos.updatedAt });
  return row as LogoMeta;
}

export async function deleteLogo(db: Db, orgId: string): Promise<boolean> {
  const rows = await db.delete(orgLogos).where(eq(orgLogos.orgId, orgId)).returning();
  return rows.length > 0;
}

/** The logo of an **active** org, by slug; null when the org is unknown, inactive or has none. */
export async function findLogoBySlug(db: Db, slug: string) {
  const [row] = await db
    .select({
      content: orgLogos.content,
      mime: orgLogos.mime,
      etag: orgLogos.etag,
      orgName: organizations.name,
    })
    .from(orgLogos)
    .innerJoin(organizations, eq(organizations.id, orgLogos.orgId))
    .where(and(eq(organizations.slug, slug), eq(organizations.isActive, true)));
  return row ?? null;
}

export async function logoMetaByOrgIds(db: Db, ids: string[]): Promise<Map<string, LogoMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ orgId: orgLogos.orgId, etag: orgLogos.etag, updatedAt: orgLogos.updatedAt })
    .from(orgLogos)
    .where(inArray(orgLogos.orgId, ids));
  return new Map(rows.map((r) => [r.orgId, { etag: r.etag, updatedAt: r.updatedAt }]));
}
