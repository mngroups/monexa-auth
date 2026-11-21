import { createPrivateKey } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { createTestDb } from "../../__tests__/db.js";
import { addMember, enableApp, seedApp, seedOrg, seedUser } from "../../__tests__/fixtures.js";
import { testEnv } from "../../__tests__/helpers.js";
import { buildApp } from "../../app.js";
import { verifyOwnToken } from "../../auth/verify-own-token.js";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { signingJwk } from "../../oidc/grant-access.js";
import { throwawaySigningKey } from "../../openapi.js";

let db: Db;
let closeDb: () => Promise<void>;
let env: Env;
let app: FastifyInstance;

async function mint(
  claims: Record<string, unknown>,
  opts: { issuer?: string; pem?: string; expiresIn?: string } = {}
) {
  const pem = opts.pem ?? env.OIDC_SIGNING_KEY;
  const jwk = signingJwk(pem);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(opts.issuer ?? `${env.OIDC_ISSUER}/oidc`)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? "5m")
    .sign(createPrivateKey(pem));
}

const get = (token?: string) =>
  app.inject({
    url: "/api/me/orgs",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  env = testEnv();
  app = await buildApp({ env, db });
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("GET /api/me/orgs", () => {
  it("lists the orgs the user may enter for the token's app, excluding orgs without it", async () => {
    const clientApp = await seedApp(db);
    const otherApp = await seedApp(db);
    const a = await seedOrg(db, { name: "Alpha" });
    const b = await seedOrg(db, { name: "Beta" });
    const c = await seedOrg(db, { name: "Gamma" });
    const user = await seedUser(db);
    for (const org of [a, b, c]) await addMember(db, user.id, org.id);
    await enableApp(db, a.id, clientApp.id);
    await enableApp(db, b.id, clientApp.id);
    await enableApp(db, c.id, otherApp.id);
    const token = await mint({ sub: user.id, client_id: clientApp.clientId, org_id: a.id });
    const res = await get(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { id: a.id, name: "Alpha" },
      { id: b.id, name: "Beta" },
    ]);
  });

  it("returns 401 without a token", async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it("returns 401 for a token signed by a foreign key", async () => {
    const token = await mint(
      { sub: "x", client_id: "y", org_id: "z" },
      { pem: throwawaySigningKey() }
    );
    expect((await get(token)).statusCode).toBe(401);
  });

  it("returns 401 for a token from another issuer or an expired one", async () => {
    const claims = { sub: "x", client_id: "y", org_id: "z" };
    expect((await get(await mint(claims, { issuer: "https://evil.example" }))).statusCode).toBe(
      401
    );
    expect((await get(await mint(claims, { expiresIn: "-1m" }))).statusCode).toBe(401);
  });

  it("returns 401 for a token missing claims, and for an app that no longer exists", async () => {
    expect((await get(await mint({ sub: "x" }))).statusCode).toBe(401);
    const user = await seedUser(db);
    const gone = await mint({ sub: user.id, client_id: "deleted-app", org_id: "z" });
    expect((await get(gone)).statusCode).toBe(401);
  });
});

describe("verifyOwnToken", () => {
  it("returns sub, clientId and orgId", async () => {
    const token = await mint({ sub: "u1", client_id: "c1", org_id: "o1" });
    expect(await verifyOwnToken(env, token)).toEqual({
      sub: "u1",
      clientId: "c1",
      orgId: "o1",
      permissions: [],
    });
  });
});
