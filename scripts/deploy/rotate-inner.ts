// Runs under `vercel env run` (see prod.ts). Prints names and outcomes only, never values.
import { eq } from "drizzle-orm";
import pg from "pg";
import { createDb } from "../../src/db/client.js";
import { apps } from "../../src/db/schema/index.js";
import { loadEnv } from "../../src/env.js";
import { encryptSecret } from "../../src/oidc/secrets.js";
import { loadDeployConfig } from "./config.js";
import { probeClientSecret } from "./probe.js";
import { DeployError, safeError, useDirectDatabaseUrl } from "./prod.js";

const what = process.argv[2];
const cfg = loadDeployConfig();

/** true / false when tested, null when the value is not readable here. */
async function canConnect(name: string): Promise<boolean | null> {
  const url = process.env[name];
  if (!url || url === "[SENSITIVE]") {
    console.log(`– ${name}: not readable here, skipped`);
    return null;
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    console.log(`✓ ${name} connects`);
    return true;
  } catch (err) {
    console.error(`✗ ${name}: ${safeError(err)}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkDatabase() {
  const results = [
    await canConnect("DATABASE_URL"),
    await canConnect("DATABASE_URL_UNPOOLED"),
    await canConnect("MIGRATION_DATABASE_URL"),
  ];
  if (results.includes(false)) throw new DeployError("a database URL does not connect");
  if (!results.includes(true)) throw new DeployError("no database URL could be tested");
}

async function rotateAdminSecret() {
  const secret = process.env.DEPLOY_NEW_ADMIN_SECRET;
  if (!secret) throw new DeployError("DEPLOY_NEW_ADMIN_SECRET missing");
  useDirectDatabaseUrl();
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL, 1);
  try {
    const updated = await db
      .update(apps)
      .set({
        clientSecretEnc: encryptSecret(secret, Buffer.from(env.CLIENT_SECRET_KEY, "base64")),
        updatedAt: new Date(),
      })
      .where(eq(apps.clientId, env.ADMIN_CLIENT_ID))
      .returning({ id: apps.id });
    if (updated.length !== 1) {
      throw new DeployError(`app ${env.ADMIN_CLIENT_ID} not found (run pnpm deploy:bootstrap)`);
    }
  } finally {
    await close().catch(() => {});
  }
  const probe = await probeClientSecret(fetch, {
    issuer: cfg.issuer,
    clientId: env.ADMIN_CLIENT_ID,
    secret,
    redirectUri: cfg.adminCallback,
  });
  if (probe !== "ok")
    throw new DeployError(`the token endpoint rejected the new secret (${probe})`);
  console.log("✓ database holds the new admin app secret; the token endpoint accepts it");
}

try {
  if (what === "db") await checkDatabase();
  else await rotateAdminSecret();
} catch (err) {
  console.error(`✗ rotate ${what}: ${safeError(err)}`);
  process.exitCode = 1;
}
