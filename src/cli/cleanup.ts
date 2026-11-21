// `pnpm auth:cleanup` (dev) or `node dist/cli/cleanup.js` (Docker, cron): deletes expired oidc_store rows.
import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";
import { cleanupExpired } from "../oidc/cleanup.js";

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL, 1);
try {
  console.log(`Deleted ${await cleanupExpired(db)} expired oidc_store rows`);
} catch (err) {
  // Message only: a driver error object can carry the query, its params and the connection string.
  const cause = (err as Error & { cause?: Error }).cause ?? (err as Error);
  console.error(`cleanup failed: ${cause.message}`);
  process.exitCode = 1;
} finally {
  await close();
}
