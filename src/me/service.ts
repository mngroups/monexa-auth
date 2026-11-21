import { AppError, MESSAGES } from "@mono/server-kit";
import { eq } from "drizzle-orm";
import { eligibleOrgs } from "../access/eligibility.js";
import { verifyOwnToken } from "../auth/verify-own-token.js";
import type { Db } from "../db/client.js";
import { apps } from "../db/schema/index.js";
import type { Env } from "../env.js";

/** Orgs the token's user may switch to in the token's app. */
export async function listMyOrgs(db: Db, env: Env, token: string) {
  const { sub, clientId } = await verifyOwnToken(env, token);
  const [app] = await db.select({ id: apps.id }).from(apps).where(eq(apps.clientId, clientId));
  // A token of an app that no longer exists is no longer valid.
  if (!app) throw new AppError(401, MESSAGES.invalidToken);
  return eligibleOrgs(db, sub, app.id, { adminClientId: env.ADMIN_CLIENT_ID });
}
