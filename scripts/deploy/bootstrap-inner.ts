// Runs under `vercel env run` (see prod.ts). Never prints the secret: it goes to the parent
// through emitSecret(), after the live token endpoint has accepted it.
import { bootstrap, readBootstrapEnv } from "../../src/bootstrap.js";
import { createDb } from "../../src/db/client.js";
import { loadEnv } from "../../src/env.js";
import { loadDeployConfig } from "./config.js";
import { probeClientSecret } from "./probe.js";
import { emitSecret, useDirectDatabaseUrl } from "./prod.js";

useDirectDatabaseUrl();
const cfg = loadDeployConfig();
const env = loadEnv();
const params = {
  ...readBootstrapEnv(process.env, env),
  rotateAdminSecret: process.argv.includes("--rotate"),
};
const { db, close } = createDb(env.DATABASE_URL, 1);
try {
  const { adminClientSecret } = await bootstrap(db, params);
  console.log(`✓ platform admin: ${params.adminEmail}`);
  if (adminClientSecret) {
    const probe = await probeClientSecret(fetch, {
      issuer: cfg.issuer,
      clientId: params.adminClientId,
      secret: adminClientSecret,
      redirectUri: cfg.adminCallback,
    });
    if (probe !== "ok") throw new Error(`the token endpoint rejected the new secret (${probe})`);
    console.log("✓ new admin app secret accepted by the token endpoint");
    emitSecret(adminClientSecret);
  }
} catch (err) {
  const cause = (err as Error & { cause?: Error }).cause ?? (err as Error);
  console.error(`✗ bootstrap failed: ${cause.message}`);
  process.exitCode = 1;
} finally {
  await close();
}
