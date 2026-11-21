import { createPrivateKey } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb } from "../../__tests__/db.js";
import { seedApp, seedUser } from "../../__tests__/fixtures.js";
import { testEnv } from "../../__tests__/helpers.js";
import { buildApp } from "../../app.js";
import type { Db } from "../../db/client.js";
import { activityLog } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { signingJwk } from "../../oidc/grant-access.js";

/** Signs an access token the way the provider does (own key, issuer, `aud` = client id). */
export async function mintToken(
  env: Env,
  claims: { sub: string; clientId?: string; aud?: string; permissions?: string[]; orgId?: string }
) {
  const pem = env.OIDC_SIGNING_KEY;
  const clientId = claims.clientId ?? env.ADMIN_CLIENT_ID;
  return new SignJWT({
    client_id: clientId,
    org_id: claims.orgId ?? "00000000-0000-4000-8000-000000000001",
    permissions: claims.permissions ?? ["platform:all"],
  })
    .setProtectedHeader({ alg: "RS256", kid: signingJwk(pem).kid })
    .setSubject(claims.sub)
    .setAudience(claims.aud ?? clientId)
    .setIssuer(`${env.OIDC_ISSUER}/oidc`)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(createPrivateKey(pem));
}

export type Admin = Awaited<ReturnType<typeof bootAdmin>>;

/** An app + PGlite db with a platform admin and a valid admin token; `call` hits `/api/admin/platform`. */
export async function bootAdmin() {
  const { db, close: closeDb } = await createTestDb();
  const env = testEnv();
  const app: FastifyInstance = await buildApp({ env, db });
  const adminApp = await seedApp(db, { clientId: env.ADMIN_CLIENT_ID, name: "Admin" });
  const user = await seedUser(db, { isPlatformAdmin: true });
  const token = await mintToken(env, { sub: user.id });
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object
  ) =>
    app.inject({
      method,
      url: `/api/admin/platform${url}`,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
  return {
    db: db as Db,
    env,
    app,
    adminApp,
    user,
    token,
    call,
    async close() {
      await app.close();
      await closeDb();
    },
  };
}

/** The activity rows of one action. */
export async function activityOf(db: Db, action: string) {
  return db.select().from(activityLog).where(eq(activityLog.action, action));
}

export async function allActivity(db: Db) {
  return db.select().from(activityLog);
}

export const MISSING_ID = "00000000-0000-4000-8000-0000000000ff";
