import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apps, oidcStore } from "../db/schema/index.js";

export type RevokeScope = { userId?: string; orgId?: string; appId?: string };

const GRANT_KINDS = ["Grant", "AccessToken", "RefreshToken", "AuthorizationCode"];

/**
 * Ends access in `oidc_store`: grants and their access tokens, refresh tokens and codes that
 * match every given filter (`user_id`, `org_id` columns; `appId` through the payload's
 * `clientId`). Sessions carry no org or app, so they go only when the scope is a user alone
 * (the user loses access everywhere); an org or app scope leaves the SSO session, whose next
 * authorization re-checks eligibility. Pass a transaction to make it part of a larger change.
 * Returns the number of grants removed.
 */
export async function revokeGrants(db: Db, scope: RevokeScope): Promise<number> {
  const { userId, orgId, appId } = scope;
  if (!userId && !orgId && !appId) throw new Error("revokeGrants needs a user, org or app");

  const filters: SQL[] = [];
  if (userId) filters.push(eq(oidcStore.userId, userId));
  if (orgId) filters.push(eq(oidcStore.orgId, orgId));
  if (appId) {
    filters.push(
      sql`${oidcStore.payload}->>'clientId' = (select ${apps.clientId} from ${apps} where ${apps.id} = ${appId})`
    );
  }
  const kinds = userId && !orgId && !appId ? [...GRANT_KINDS, "Session"] : GRANT_KINDS;

  const removed = await db
    .delete(oidcStore)
    .where(and(inArray(oidcStore.kind, kinds), ...filters))
    .returning({ kind: oidcStore.kind });
  return removed.filter((r) => r.kind === "Grant").length;
}
