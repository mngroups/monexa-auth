import { createPrivateKey } from "node:crypto";
import { createServer } from "node:net";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../__tests__/db.js";
import { addMember, enableApp, seedApp, seedOrg, seedUser } from "../../__tests__/fixtures.js";
import { okDb, testEnv } from "../../__tests__/helpers.js";
import { buildApp } from "../../app.js";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { signingJwk } from "../../oidc/grant-access.js";

const REDIRECT = "http://localhost:3001/auth/callback";

/** A free local port: the kit discovers the issuer over real HTTP, so the app must listen. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

let db: Db;
let closeDb: () => Promise<void>;
let env: Env;
let app: FastifyInstance;
let hintedApp: FastifyInstance;
let hintedEnv: Env;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const port = await freePort();
  env = testEnv({
    OIDC_ISSUER: `http://127.0.0.1:${port}`,
    ADMIN_CLIENT_SECRET: "admin-secret",
  });
  app = await buildApp({ env, db });
  await app.listen({ port, host: "127.0.0.1" });
  const hintedPort = await freePort();
  hintedEnv = testEnv({
    OIDC_ISSUER: `http://127.0.0.1:${hintedPort}`,
    ADMIN_CLIENT_SECRET: "admin-secret",
    ADMIN_ORG_HINT: "monexa",
  });
  hintedApp = await buildApp({ env: hintedEnv, db });
  await hintedApp.listen({ port: hintedPort, host: "127.0.0.1" });
});

afterAll(async () => {
  await hintedApp.close();
  await app.close();
  await closeDb();
});

const authorizeUrl = (redirect: string) =>
  app.inject({ url: `/v1/auth/authorize-url?redirect_uri=${encodeURIComponent(redirect)}` });

describe("kit auth routes for the admin app", () => {
  it("starts an sso login for the admin client against this issuer", async () => {
    const res = await authorizeUrl(REDIRECT);
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().data.url);
    expect(url.href.startsWith(`${env.OIDC_ISSUER}/oidc/auth`)).toBe(true);
    expect(url.searchParams.get("client_id")).toBe("monexa-admin");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  it("carries org_hint in the authorize URL only when ADMIN_ORG_HINT is set", async () => {
    const plain = new URL((await authorizeUrl(REDIRECT)).json().data.url);
    expect(plain.searchParams.has("org_hint")).toBe(false);
    const res = await hintedApp.inject({
      url: `/v1/auth/authorize-url?redirect_uri=${encodeURIComponent(REDIRECT)}`,
    });
    expect(new URL(res.json().data.url).searchParams.get("org_hint")).toBe("monexa");
  });

  it("returns the end_session_url with the default post-logout URI", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/auth/logout", payload: {} });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().data.end_session_url);
    expect(url.href.startsWith(`${env.OIDC_ISSUER}/oidc/session/end`)).toBe(true);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:3001/login");
  });

  it("refuses a redirect_uri outside ADMIN_REDIRECT_URIS", async () => {
    expect((await authorizeUrl("https://evil.test/auth/callback")).statusCode).toBe(422);
  });

  it("leaves other apps' tokens on /api/me/orgs alone", async () => {
    const clientApp = await seedApp(db);
    const org = await seedOrg(db, { name: "Alpha" });
    const user = await seedUser(db);
    await addMember(db, user.id, org.id);
    await enableApp(db, org.id, clientApp.id);
    const jwk = signingJwk(env.OIDC_SIGNING_KEY);
    const token = await new SignJWT({ sub: user.id, client_id: clientApp.clientId, org_id: org.id })
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid, typ: "at+jwt" })
      .setIssuer(`${env.OIDC_ISSUER}/oidc`)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(createPrivateKey(env.OIDC_SIGNING_KEY));
    const res = await app.inject({
      url: "/api/me/orgs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("keeps provider and interaction routes free of the kit's bearer check", async () => {
    const discovery = await app.inject({ url: "/oidc/.well-known/openid-configuration" });
    expect(discovery.statusCode).toBe(200);
    const interaction = await app.inject({ url: "/interaction/unknown-uid" });
    expect(interaction.statusCode).not.toBe(401);
  });
});

describe("before bootstrap (no admin client secret)", () => {
  it("boots and serves health, without the kit auth routes", async () => {
    const bare = await buildApp({ env: testEnv(), db: okDb as never });
    expect((await bare.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await bare.inject({ url: "/v1/auth/authorize-url" })).statusCode).toBe(404);
    await bare.close();
  });
});
