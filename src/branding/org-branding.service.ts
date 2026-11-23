import { AppError } from "@mono/server-kit";
import type { Db } from "../db/client.js";
import { MESSAGES_AUTH } from "../messages.js";
import { logoMetaByOrgIds } from "./logo.repository.js";
import { toLogo } from "./logo.service.js";
import { findOrgBranding } from "./org-branding.repository.js";

/** An org's slug, name and login-logo state. */
export async function orgBranding(db: Db, orgId: string) {
  const org = await findOrgBranding(db, orgId);
  if (!org) throw new AppError(404, MESSAGES_AUTH.orgNotFound);
  const metas = (await logoMetaByOrgIds(db, [orgId])).get(orgId);
  return {
    slug: org.slug,
    name: org.name,
    logo: toLogo(metas?.logo),
    logoDark: toLogo(metas?.logoDark),
  };
}
