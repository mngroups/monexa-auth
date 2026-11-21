import { createServer } from "node:net";
import { auth, envelope, errorHandler } from "@mono/server-kit";
import { and, eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { decodeJwt } from "jose";
import { createTestDb } from "../../__tests__/db.js";
import {
  addMember,
  assignRole,
  enableApp,
  getUser,
  seedClient,
  seedOrg,
  seedRole,
  seedUser,
} from "../../__tests__/fixtures.js";
import { testEnv } from "../../__tests__/helpers.js";
import { buildApp } from "../../app.js";
import type { Db } from "../../db/client.js";
import { activityLog, memberRoles, memberships, oidcStore, users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { hashPassword } from "../../users/passwords.js";

const PASSWORD = "correct horse battery";
const CATALOG = ["example.item:view", "example.item:edit", "example.item:delete"];

let db: Db;
let closeDb: () => Promise<void>;
let env: Env;
let key: Buffer;
let server: FastifyInstance;
let issuer: string;
let passwordHash: string;
const kits: FastifyInstance[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** A Monexa backend: the real kit `auth` plugin in credentials mode against monexa-auth. */
async function kitApp(clientId: string, clientSecret: string) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(envelope);
  await app.register(errorHandler);
  await app.register(auth, {
    mode: "credentials",
    issuer,
    clientId,
    clientSecret,
    jwksCooldownMs: 0,
  });
  kits.push(app);
  return app;
}

/** A raw token-endpoint request (form-encoded, client_secret_basic) straight to the provider. */
async function tokenRequest(clientId: string, secret: string, params: Record<string, string>) {
  const res = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const passwordGrant = (username: string, extra: Record<string, string> = {}) => ({
  grant_type: "password",
  username,
  password: PASSWORD,
  scope: "openid",
  ...extra,
});

/** An app enabled in two orgs, a user with a different role in each, last used org B. */
async function scenario(appOverrides: Parameters<typeof seedClient>[2] = {}) {
  const { app, secret } = await seedClient(
    db,
    key,
    {
      allowedGrants: ["password"],
      refreshTtlSeconds: 3600,
      accessTtlSeconds: 300,
      ...appOverrides,
    },
    CATALOG
  );
  const orgA = await seedOrg(db, { name: "Alpha" });
  const orgB = await seedOrg(db, { name: "Beta" });
  const user = await seedUser(db, { passwordHash, lastOrgId: orgB.id });
  for (const org of [orgA, orgB]) {
    await enableApp(db, org.id, app.id);
    await addMember(db, user.id, org.id);
  }
  const viewer = await seedRole(db, app.id, "viewer", ["example.item:view"]);
  const editor = await seedRole(db, app.id, "editor", ["example.item:edit", "example.item:view"]);
  await assignRole(db, user.id, orgA.id, viewer.id);
  await assignRole(db, user.id, orgB.id, editor.id);
  const kit = await kitApp(app.clientId, secret);
  return { app, secret, orgA, orgB, user, editor, kit };
}

async function kitLogin(kit: FastifyInstance, username: string, password = PASSWORD) {
  return kit.inject({ method: "POST", url: "/v1/auth/login", payload: { username, password } });
}

async function kitRefresh(kit: FastifyInstance, refreshToken: string) {
  return kit.inject({
    method: "POST",
    url: "/v1/auth/refresh",
    payload: { refresh_token: refreshToken },
  });
}

async function kitCheck(kit: FastifyInstance, accessToken: string) {
  return kit.inject({
    url: "/v1/auth/check",
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  passwordHash = await hashPassword(PASSWORD);
  const port = await freePort();
  env = testEnv({ OIDC_ISSUER: `http://127.0.0.1:${port}` });
  key = Buffer.from(env.CLIENT_SECRET_KEY, "base64");
  issuer = `${env.OIDC_ISSUER}/oidc`;
  server = await buildApp({ env, db });
  await server.listen({ port, host: "127.0.0.1" });
});

afterAll(async () => {
  await Promise.all(kits.map((k) => k.close()));
  await server.close();
  await closeDb();
});

describe("credentials contract (kit auth plugin → monexa-auth)", () => {
  it("serves discovery and JWKS under /oidc", async () => {
    const discovery = (await (
      await fetch(`${issuer}/.well-known/openid-configuration`)
    ).json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      issuer,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      revocation_endpoint: `${issuer}/token/revocation`,
    });
    expect(discovery.end_session_endpoint).toBe(`${issuer}/session/end`);
    const jwks = (await (await fetch(`${issuer}/jwks`)).json()) as { keys: { kid: string }[] };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(jwks.keys[0]).not.toHaveProperty("d");
  });

  it("logs in through the kit with the FE token shape and claims for the last-used org", async () => {
    const { app, orgB, user, kit } = await scenario();
    const res = await kitLogin(kit, user.email);
    expect(res.statusCode).toBe(200);
    const tokens = res.json().data;
    expect(Object.keys(tokens).sort()).toEqual([
      "access_token",
      "expires_in",
      "refresh_expires_in",
      "refresh_token",
    ]);
    expect(tokens.expires_in).toBe(300);
    expect(tokens.refresh_expires_in).toBe(3600);

    const check = await kitCheck(kit, tokens.access_token);
    expect(check.statusCode).toBe(200);
    expect(check.json().data).toEqual({
      user_id: user.id,
      permissions: ["example.item:edit", "example.item:view"],
    });

    const claims = decodeJwt(tokens.access_token);
    expect(claims).toMatchObject({
      iss: issuer,
      sub: user.id,
      aud: app.clientId,
      azp: app.clientId,
      client_id: app.clientId,
      org_id: orgB.id,
      org_name: "Beta",
      permissions: ["example.item:edit", "example.item:view"],
    });

    const [logged] = await db
      .select()
      .from(activityLog)
      .where(
        and(eq(activityLog.actorUserId, user.id), eq(activityLog.action, "auth.login.succeeded"))
      );
    expect(logged).toMatchObject({
      orgId: orgB.id,
      targetType: "user",
      targetId: user.id,
      metadata: { client_id: app.clientId },
    });
  });

  it("accepts org_id on the raw grant and remembers it as the last-used org", async () => {
    const { app, secret, orgA, user } = await scenario();
    const res = await tokenRequest(
      app.clientId,
      secret,
      passwordGrant(user.username ?? user.email, { org_id: orgA.id })
    );
    expect(res.status).toBe(200);
    expect(res.body.refresh_expires_in).toBe(3600);
    expect(decodeJwt(res.body.access_token as string)).toMatchObject({
      org_id: orgA.id,
      org_name: "Alpha",
      permissions: ["example.item:view"],
    });
    expect((await getUser(db, user.id)).lastOrgId).toBe(orgA.id);
  });

  it("rejects a wrong password with 401 and logs the failure without secrets", async () => {
    const { app, secret, user, kit } = await scenario();
    const res = await kitLogin(kit, user.email, "wrong password");
    expect(res.statusCode).toBe(401);
    const raw = await tokenRequest(app.clientId, secret, {
      ...passwordGrant(user.email),
      password: "wrong password",
    });
    expect(raw).toMatchObject({
      status: 400,
      body: { error: "invalid_grant", error_description: "invalid_credentials" },
    });
    const failures = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.targetId, user.id), eq(activityLog.action, "auth.login.failed")));
    expect(failures).toHaveLength(2);
    expect(failures[0]?.metadata).toEqual({
      client_id: app.clientId,
      reason: "invalid_credentials",
    });
    expect(JSON.stringify(failures)).not.toContain("wrong password");
  });

  it("names the reason in error_description: no_app_access, org_not_eligible, password_change_required", async () => {
    const { app, secret, kit } = await scenario();
    const loner = await seedUser(db, { passwordHash });
    expect((await kitLogin(kit, loner.email)).statusCode).toBe(401);
    expect(await tokenRequest(app.clientId, secret, passwordGrant(loner.email))).toMatchObject({
      status: 400,
      body: { error: "invalid_grant", error_description: "no_app_access" },
    });

    const other = await scenario();
    const otherOrg = await seedOrg(db);
    expect(
      await tokenRequest(
        other.app.clientId,
        other.secret,
        passwordGrant(other.user.email, { org_id: otherOrg.id })
      )
    ).toMatchObject({ body: { error: "invalid_grant", error_description: "org_not_eligible" } });

    const stale = await seedUser(db, { passwordHash, mustChangePassword: true });
    expect(await tokenRequest(app.clientId, secret, passwordGrant(stale.email))).toMatchObject({
      body: { error: "invalid_grant", error_description: "password_change_required" },
    });
  });

  it("rejects the password grant for an app that does not allow it", async () => {
    const { app, secret } = await seedClient(db, key, {
      allowedGrants: ["authorization_code"],
      redirectUris: ["https://app.example.com/cb"],
    });
    const res = await tokenRequest(app.clientId, secret, passwordGrant("anyone@example.com"));
    expect(res).toMatchObject({ status: 400, body: { error: "unauthorized_client" } });
  });

  it("requires username and password", async () => {
    const { app, secret } = await scenario();
    const res = await tokenRequest(app.clientId, secret, { grant_type: "password", username: "x" });
    expect(res).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });

  it("refreshes through the kit, rotating the refresh token; reuse is rejected", async () => {
    const { user, kit } = await scenario();
    const first = (await kitLogin(kit, user.email)).json().data;
    const refreshed = await kitRefresh(kit, first.refresh_token);
    expect(refreshed.statusCode).toBe(200);
    const second = refreshed.json().data;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.refresh_expires_in).toBe(3600);
    expect((await kitCheck(kit, second.access_token)).statusCode).toBe(200);
    expect((await kitRefresh(kit, first.refresh_token)).statusCode).toBe(401);
  });

  it("lets only one of two concurrent refreshes with the same token succeed", async () => {
    const { user, kit } = await scenario();
    const { refresh_token } = (await kitLogin(kit, user.email)).json().data;
    const results = await Promise.all([
      kitRefresh(kit, refresh_token),
      kitRefresh(kit, refresh_token),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401]);
  });

  it("keeps the grant's org on refresh and records user and org on the stored rows", async () => {
    const { orgA, orgB, user, kit } = await scenario();
    const { refresh_token } = (await kitLogin(kit, user.email)).json().data;
    const rows = await db.select().from(oidcStore).where(eq(oidcStore.userId, user.id));
    expect(rows.map((r) => [r.kind, r.orgId]).sort()).toEqual([
      ["Grant", orgB.id],
      ["RefreshToken", orgB.id],
    ]);
    expect(rows.find((r) => r.kind === "Grant")?.payload).toMatchObject({ orgId: orgB.id });
    // The org comes from the grant, not from the (since changed) last-used org.
    await db.update(users).set({ lastOrgId: orgA.id }).where(eq(users.id, user.id));
    const refreshed = await kitRefresh(kit, refresh_token);
    expect(decodeJwt(refreshed.json().data.access_token)).toMatchObject({ org_id: orgB.id });
  });

  it("recomputes permissions on refresh after a role is unassigned", async () => {
    const { orgB, user, editor, kit } = await scenario();
    const { refresh_token } = (await kitLogin(kit, user.email)).json().data;
    await db
      .delete(memberRoles)
      .where(and(eq(memberRoles.userId, user.id), eq(memberRoles.roleId, editor.id)));
    const refreshed = await kitRefresh(kit, refresh_token);
    expect(refreshed.statusCode).toBe(200);
    const claims = decodeJwt(refreshed.json().data.access_token);
    expect(claims).toMatchObject({ org_id: orgB.id, permissions: [] });
  });

  it("rejects refresh with org_not_eligible once the membership is deactivated", async () => {
    const { app, secret, orgB, user, kit } = await scenario();
    const login = await tokenRequest(app.clientId, secret, passwordGrant(user.email));
    const { refresh_token } = (await kitLogin(kit, user.email)).json().data;
    await db
      .update(memberships)
      .set({ isActive: false })
      .where(and(eq(memberships.userId, user.id), eq(memberships.orgId, orgB.id)));
    expect((await kitRefresh(kit, refresh_token)).statusCode).toBe(401);
    expect(
      await tokenRequest(app.clientId, secret, {
        grant_type: "refresh_token",
        refresh_token: login.body.refresh_token as string,
      })
    ).toMatchObject({
      status: 400,
      body: { error: "invalid_grant", error_description: "org_not_eligible" },
    });
  });

  it("rejects refresh with invalid_credentials once the user is deactivated", async () => {
    const { app, secret, user } = await scenario();
    const login = await tokenRequest(app.clientId, secret, passwordGrant(user.email));
    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    expect(
      await tokenRequest(app.clientId, secret, {
        grant_type: "refresh_token",
        refresh_token: login.body.refresh_token as string,
      })
    ).toMatchObject({
      status: 400,
      body: { error: "invalid_grant", error_description: "invalid_credentials" },
    });
  });

  it("revokes the refresh token on kit logout", async () => {
    const { user, kit } = await scenario();
    const { refresh_token } = (await kitLogin(kit, user.email)).json().data;
    const logout = await kit.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token },
    });
    expect(logout.statusCode).toBe(200);
    expect((await kitRefresh(kit, refresh_token)).statusCode).toBe(401);
  });
});
