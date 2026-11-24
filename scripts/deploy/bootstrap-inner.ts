// Runs under `vercel env run` (see prod.ts). Prints names and outcomes only, never values.
//   --check: exit 10 when the admin app exists, 0 when it does not (no change made)
//   default: runs the bootstrap; a new or rotated secret is DEPLOY_NEW_ADMIN_SECRET, already
//            saved in Vercel by the caller, and is checked against the live token endpoint.
import { eq } from "drizzle-orm";
import { bootstrap, readBootstrapEnv } from "../../src/bootstrap.js";
import { createDb } from "../../src/db/client.js";
import { apps } from "../../src/db/schema/index.js";
import { loadEnv } from "../../src/env.js";
import { loadDeployConfig } from "./config.js";
import { probeClientSecret } from "./probe.js";
import { DeployError, safeError, useDirectDatabaseUrl } from "./prod.js";

const cfg = loadDeployConfig();

async function main() {
  useDirectDatabaseUrl();
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL, 1);
  try {
    if (process.argv.includes("--check")) {
      const [app] = await db
        .select({ id: apps.id })
        .from(apps)
        .where(eq(apps.clientId, env.ADMIN_CLIENT_ID));
      console.log(`· admin app ${env.ADMIN_CLIENT_ID}: ${app ? "exists" : "not created yet"}`);
      return app ? 10 : 0;
    }
    const given = process.env.DEPLOY_NEW_ADMIN_SECRET;
    const params = {
      ...readBootstrapEnv(process.env, env),
      rotateAdminSecret: process.argv.includes("--rotate"),
      adminClientSecret: given,
    };
    const { adminClientSecret } = await bootstrap(db, params);
    console.log(`✓ platform admin: ${params.adminEmail}`);
    if (adminClientSecret && adminClientSecret !== given) {
      throw new DeployError(
        "a secret was issued that the caller did not save; re-run with --rotate"
      );
    }
    if (adminClientSecret) {
      const probe = await probeClientSecret(fetch, {
        issuer: cfg.issuer,
        clientId: params.adminClientId,
        secret: adminClientSecret,
        redirectUri: cfg.adminCallback,
      });
      if (probe !== "ok")
        throw new DeployError(`the token endpoint rejected the new secret (${probe})`);
      console.log("✓ database holds the new admin app secret; the token endpoint accepts it");
    }
    return 0;
  } finally {
    await close().catch(() => {});
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`✗ bootstrap: ${safeError(err)}`);
  process.exitCode = 1;
}
