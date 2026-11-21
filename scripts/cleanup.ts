// `pnpm auth:cleanup`: deletes expired oidc_store rows. Run it from cron, see README.
import { createDb } from "../src/db/client.js";
import { loadEnv } from "../src/env.js";
import { cleanupExpired } from "../src/oidc/cleanup.js";

const env = loadEnv();
const { db, close } = createDb(env.DATABASE_URL, 1);
try {
  console.log(`Deleted ${await cleanupExpired(db)} expired oidc_store rows`);
} finally {
  await close();
}
