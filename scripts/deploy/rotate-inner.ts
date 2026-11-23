// Runs under `vercel env run` (see prod.ts). Values never reach stdout except through emitSecret().
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { createDb } from "../../src/db/client.js";
import { apps } from "../../src/db/schema/index.js";
import { loadEnv } from "../../src/env.js";
import { encryptSecret } from "../../src/oidc/secrets.js";
import { loadDeployConfig } from "./config.js";
import { probeClientSecret } from "./probe.js";
import { emitSecret, useDirectDatabaseUrl } from "./prod.js";

const what = process.argv[2];
const cfg = loadDeployConfig();

async function canConnect(name: string): Promise<boolean> {
  const url = process.env[name];
  if (!url || url === "[SENSITIVE]") {
    console.log(`– ${name}: not readable here, skipped`);
    return true;
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    console.log(`✓ ${name} connects`);
    return true;
  } catch (err) {
    console.error(`✗ ${name}: ${(err as { code?: string }).code ?? "connection failed"}`);
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

try {
  if (what === "db") {
    const ok = [
      await canConnect("DATABASE_URL"),
      await canConnect("DATABASE_URL_UNPOOLED"),
      await canConnect("MIGRATION_DATABASE_URL"),
    ];
    if (ok.includes(false)) {
      throw new Error("a database URL does not connect; check the Neon integration env");
    }
  } else {
    useDirectDatabaseUrl();
    const env = loadEnv();
    const secret = randomBytes(32).toString("base64url");
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
      if (updated.length !== 1)
        throw new Error(`app ${env.ADMIN_CLIENT_ID} not found (bootstrap first)`);
    } finally {
      await close();
    }
    const probe = await probeClientSecret(fetch, {
      issuer: cfg.issuer,
      clientId: env.ADMIN_CLIENT_ID,
      secret,
      redirectUri: cfg.adminCallback,
    });
    if (probe !== "ok") throw new Error(`the token endpoint rejected the new secret (${probe})`);
    console.log("✓ new admin app secret stored and accepted by the token endpoint");
    emitSecret(secret);
  }
} catch (err) {
  console.error(`✗ rotate ${what} failed: ${(err as Error).message}`);
  process.exitCode = 1;
}
