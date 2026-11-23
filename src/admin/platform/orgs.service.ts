import { AppError } from "@mono/server-kit";
import * as logos from "../../branding/logo.repository.js";
import { type LogoUpload, removeLogo, setLogo, toLogo } from "../../branding/logo.service.js";
import type { Db } from "../../db/client.js";
import type { OrganizationRow } from "../../db/schema/index.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { revokeGrants } from "../../oidc/revoke.js";
import { type Actor, audit, iso, orConflict, type PageQuery } from "./common.js";
import * as repo from "./orgs.repository.js";

export const toOrg = (o: OrganizationRow, logo: logos.LogoMetas | undefined) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  isActive: o.isActive,
  createdAt: iso(o.createdAt),
  updatedAt: iso(o.updatedAt),
  logo: toLogo(logo?.logo),
  logoDark: toLogo(logo?.logoDark),
});

/** `toOrg` with the org's current logo state. */
async function orgWithLogo(db: Db, o: OrganizationRow) {
  return toOrg(o, (await logos.logoMetaByOrgIds(db, [o.id])).get(o.id));
}

async function requireOrg(db: Db, id: string) {
  const org = await repo.findOrg(db, id);
  if (!org) throw new AppError(404, MESSAGES_AUTH.orgNotFound);
  return org;
}

export async function listOrgs(db: Db, q: PageQuery & { q?: string }) {
  const { items, total } = await repo.listOrgs(db, q);
  const metas = await logos.logoMetaByOrgIds(
    db,
    items.map((o) => o.id)
  );
  return {
    items: items.map((o) => toOrg(o, metas.get(o.id))),
    page: q.page,
    pageSize: q.pageSize,
    total,
  };
}

export function createOrg(db: Db, actor: Actor, input: { slug: string; name: string }) {
  return orConflict(MESSAGES_AUTH.orgSlugTaken, () =>
    db.transaction(async (tx) => {
      const org = await repo.insertOrg(tx, input);
      await audit(tx, actor, {
        action: "admin.org.created",
        targetType: "org",
        targetId: org.id,
        orgId: org.id,
        metadata: { slug: org.slug, name: org.name },
      });
      return toOrg(org, undefined);
    })
  );
}

export function updateOrg(
  db: Db,
  actor: Actor,
  id: string,
  input: Partial<{ slug: string; name: string }>
) {
  return orConflict(MESSAGES_AUTH.orgSlugTaken, () =>
    db.transaction(async (tx) => {
      const org = await repo.updateOrg(tx, id, input);
      if (!org) throw new AppError(404, MESSAGES_AUTH.orgNotFound);
      await audit(tx, actor, {
        action: "admin.org.updated",
        targetType: "org",
        targetId: id,
        orgId: id,
        metadata: { fields: Object.keys(input) },
      });
      return orgWithLogo(tx, org);
    })
  );
}

export function setOrgActive(db: Db, actor: Actor, id: string, isActive: boolean) {
  return db.transaction(async (tx) => {
    const org = await repo.updateOrg(tx, id, { isActive });
    if (!org) throw new AppError(404, MESSAGES_AUTH.orgNotFound);
    await audit(tx, actor, {
      action: isActive ? "admin.org.activated" : "admin.org.deactivated",
      targetType: "org",
      targetId: id,
      orgId: id,
    });
    return orgWithLogo(tx, org);
  });
}

export async function listOrgApps(db: Db, orgId: string) {
  await requireOrg(db, orgId);
  return repo.appsWithEnablement(db, orgId);
}

export function enableOrgApp(db: Db, actor: Actor, orgId: string, appId: string) {
  return db.transaction(async (tx) => {
    await requireOrg(tx, orgId);
    if (!(await repo.appExists(tx, appId))) throw new AppError(404, MESSAGES_AUTH.appNotFound);
    await repo.enableOrgApp(tx, orgId, appId);
    await audit(tx, actor, {
      action: "admin.org_app.enabled",
      targetType: "org_app",
      targetId: `${orgId}:${appId}`,
      orgId,
      metadata: { appId },
    });
    return { orgId, appId, enabled: true, revokedGrants: 0 };
  });
}

/** Disabling ends every grant of that org for that app, in the same transaction. */
export function disableOrgApp(db: Db, actor: Actor, orgId: string, appId: string) {
  return db.transaction(async (tx) => {
    await requireOrg(tx, orgId);
    if (!(await repo.disableOrgApp(tx, orgId, appId))) {
      throw new AppError(404, MESSAGES_AUTH.appNotFound);
    }
    const revokedGrants = await revokeGrants(tx, { orgId, appId });
    await audit(tx, actor, {
      action: "admin.org_app.disabled",
      targetType: "org_app",
      targetId: `${orgId}:${appId}`,
      orgId,
      metadata: { appId, revokedGrants },
    });
    return { orgId, appId, enabled: false, revokedGrants };
  });
}

/** Any org's login logo, for platform admins (the Organizations page). */
export async function setOrgLogo(
  db: Db,
  actor: Actor,
  id: string,
  file: LogoUpload | undefined,
  variant: logos.LogoVariant = "default"
) {
  await requireOrg(db, id);
  return setLogo(db, actor, id, file, variant);
}

export async function removeOrgLogo(
  db: Db,
  actor: Actor,
  id: string,
  variant: logos.LogoVariant = "default"
) {
  await requireOrg(db, id);
  return removeLogo(db, actor, id, variant);
}
