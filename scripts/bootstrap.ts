// `pnpm auth:bootstrap`: first-run setup (idempotent). Inputs come from env, see README.
import { bootstrap, readBootstrapEnv } from "../src/bootstrap.js";
import { createDb } from "../src/db/client.js";
import { loadEnv } from "../src/env.js";

const env = loadEnv();
const params = readBootstrapEnv(process.env, env);
const { db, close } = createDb(env.DATABASE_URL, 1);
try {
  const { adminClientSecret } = await bootstrap(db, params);
  console.log(`Platform admin: ${params.adminEmail}`);
  if (adminClientSecret) {
    console.log(`Admin app client id: ${params.adminClientId}`);
    console.log(`Admin app client secret (shown once, store it now): ${adminClientSecret}`);
  } else {
    console.log("Admin app already exists; its client secret is unchanged.");
  }
} finally {
  await close();
}
