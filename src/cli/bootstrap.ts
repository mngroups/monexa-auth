// `pnpm auth:bootstrap` (dev) or `node dist/cli/bootstrap.js` (Docker): first-run setup (idempotent).
// Inputs come from env, see README.
import { bootstrap, readBootstrapEnv } from "../bootstrap.js";
import { createDb } from "../db/client.js";
import { loadEnv } from "../env.js";

const env = loadEnv();
const params = readBootstrapEnv(process.env, env);
const { db, close } = createDb(env.DATABASE_URL, 1);
try {
  const { adminClientSecret } = await bootstrap(db, params);
  console.log(`Platform admin: ${params.adminEmail}`);
  if (adminClientSecret) {
    console.log(`Admin app client id: ${params.adminClientId}`);
    console.log(`Admin app client secret (shown once, store it now): ${adminClientSecret}`);
    console.log("Put it in this service's ADMIN_CLIENT_SECRET and restart it.");
  } else {
    console.log(
      "Admin app already exists; its client secret is unchanged (BOOTSTRAP_ROTATE_ADMIN_SECRET=true issues a new one)."
    );
  }
} catch (err) {
  // Message only: a driver error object can carry the query, its params and the connection string.
  const cause = (err as Error & { cause?: Error }).cause ?? (err as Error);
  console.error(`bootstrap failed: ${cause.message}`);
  process.exitCode = 1;
} finally {
  await close();
}
