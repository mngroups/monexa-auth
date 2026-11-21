import { lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { oidcStore } from "../db/schema/index.js";

/**
 * Deletes `oidc_store` rows past `expires_at` and returns how many went. Run it from cron
 * (`pnpm auth:cleanup`), never inside request handling. Rows without an expiry stay.
 */
export async function cleanupExpired(db: Db, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(oidcStore)
    .where(lt(oidcStore.expiresAt, now))
    .returning({ id: oidcStore.id });
  return removed.length;
}
