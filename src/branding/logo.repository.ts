import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { organizations, orgLogos, orgLogosDark } from "../db/schema/index.js";

export type LogoMeta = { etag: string; updatedAt: Date };
export type LogoVariant = "default" | "dark";
/** An org's logo state per variant, as the admin API names it. */
export type LogoMetas = { logo?: LogoMeta; logoDark?: LogoMeta };

/** The variants share one shape, so every query is written once against the table of the variant. */
const tableOf = (variant: LogoVariant): typeof orgLogos =>
  variant === "dark" ? (orgLogosDark as unknown as typeof orgLogos) : orgLogos;

export async function upsertLogo(
  db: Db,
  v: { orgId: string; content: Buffer; mime: string; etag: string; updatedBy: string },
  variant: LogoVariant = "default"
): Promise<LogoMeta> {
  const t = tableOf(variant);
  const values = { ...v, size: v.content.length, updatedAt: new Date() };
  const [row] = await db
    .insert(t)
    .values(values)
    .onConflictDoUpdate({ target: t.orgId, set: values })
    .returning({ etag: t.etag, updatedAt: t.updatedAt });
  return row as LogoMeta;
}

export async function deleteLogo(
  db: Db,
  orgId: string,
  variant: LogoVariant = "default"
): Promise<boolean> {
  const t = tableOf(variant);
  const rows = await db.delete(t).where(eq(t.orgId, orgId)).returning();
  return rows.length > 0;
}

/** One variant of the logo of an **active** org, by slug; null when the org is unknown, inactive or lacks it. */
export async function findLogoBySlug(db: Db, slug: string, variant: LogoVariant = "default") {
  const t = tableOf(variant);
  const [row] = await db
    .select({ content: t.content, mime: t.mime, etag: t.etag, orgName: organizations.name })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(and(eq(organizations.slug, slug), eq(organizations.isActive, true)));
  return row ?? null;
}

export async function logoMetaByOrgIds(db: Db, ids: string[]): Promise<Map<string, LogoMetas>> {
  const out = new Map<string, LogoMetas>();
  if (ids.length === 0) return out;
  for (const [variant, key] of [
    ["default", "logo"],
    ["dark", "logoDark"],
  ] as const) {
    const t = tableOf(variant);
    const rows = await db
      .select({ orgId: t.orgId, etag: t.etag, updatedAt: t.updatedAt })
      .from(t)
      .where(inArray(t.orgId, ids));
    for (const r of rows) {
      out.set(r.orgId, { ...out.get(r.orgId), [key]: { etag: r.etag, updatedAt: r.updatedAt } });
    }
  }
  return out;
}
