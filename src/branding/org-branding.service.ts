import { AppError } from "@mono/server-kit";
import * as orgs from "../admin/platform/orgs.repository.js";
import type { Db } from "../db/client.js";
import { MESSAGES_AUTH } from "../messages.js";
import { logoMetaByOrgIds } from "./logo.repository.js";
import { toLogo } from "./logo.service.js";

/** An org's slug, name and login-logo state. */
export async function orgBranding(db: Db, orgId: string) {
  const org = await orgs.findOrg(db, orgId);
  if (!org) throw new AppError(404, MESSAGES_AUTH.orgNotFound);
  return {
    slug: org.slug,
    name: org.name,
    logo: toLogo((await logoMetaByOrgIds(db, [orgId])).get(orgId)),
  };
}
