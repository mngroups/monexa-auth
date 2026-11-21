import { createServer } from "node:net";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
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
import { memberships, oidcStore, users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { hashPassword } from "../../users/passwords.js";

const PASSWORD = "correct horse battery";
const CATALOG = ["example.item:view", "example.item:edit"];
const SWITCH = "urn:monexa:params:oauth:grant-type:org-switch";

let db: Db;
let closeDb: () => Promise<void>;
let env: Env;
let key: Buffer;
let server: FastifyInstance;
let issuer: string;
let passwordHash: string;

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

async function scenario() {
  const { app, secret } = await seedClient(
    db,
    key,
    { allowedGrants: ["password"], refreshTtlSeconds: 3600, accessTtlSeconds: 300 },
    CATALOG
  );
  const orgA = await seedOrg(db, { name: "Alpha" });
  const orgB = await seedOrg(db, { name: "Beta" });
  const user = await seedUser(db, { passwordHash, lastOrgId: orgA.id });
  for (const org of [orgA, orgB]) {
    await enableApp(db, org.id, app.id);
    await addMember(db, user.id, org.id);
  }
  const viewer = await seedRole(db, app.id, "viewer", ["example.item:view"]);
  const editor = await seedRole(db, app.id, "editor", ["example.item:edit"]);
  await assignRole(db, user.id, orgA.id, viewer.id);
  await assignRole(db, user.id, orgB.id, editor.id);
  const login = await tokenRequest(app.clientId, secret, {
    grant_type: "password",
    username: user.email,
    password: PASSWORD,
    scope: "openid",
    org_id: orgA.id,
  });
  expect(login.status).toBe(200);
  return { app, secret, orgA, orgB, user, refresh: login.body.refresh_token as string };
}

const switchTo = (
  s: { app: { clientId: string }; secret: string },
  refresh: string,
  orgId: string
) =>
  tokenRequest(s.app.clientId, s.secret, {
    grant_type: SWITCH,
    refresh_token: refresh,
    org_id: orgId,
  });

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
  await server.close();
  await closeDb();
});

describe("org-switch grant", () => {
  it("issues tokens for the new org, revokes the old refresh token and remembers the org", async () => {
    const s = await scenario();
    const res = await switchTo(s, s.refresh, s.orgB.id);
    expect(res.status).toBe(200);
    expect(res.body.refresh_expires_in).toBe(3600);
    expect(res.body.expires_in).toBe(300);
    expect(decodeJwt(res.body.access_token as string)).toMatchObject({
      sub: s.user.id,
      aud: s.app.clientId,
      azp: s.app.clientId,
      org_id: s.orgB.id,
      org_name: "Beta",
      permissions: ["example.item:edit"],
    });
    expect((await getUser(db, s.user.id)).lastOrgId).toBe(s.orgB.id);

    // The old refresh token (and its grant) is gone.
    expect(
      await tokenRequest(s.app.clientId, s.secret, {
        grant_type: "refresh_token",
        refresh_token: s.refresh,
      })
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // The new one works and stays in org B.
    const next = await tokenRequest(s.app.clientId, s.secret, {
      grant_type: "refresh_token",
      refresh_token: res.body.refresh_token as string,
    });
    expect(next.status).toBe(200);
    expect(decodeJwt(next.body.access_token as string)).toMatchObject({ org_id: s.orgB.id });
    const rows = await db.select().from(oidcStore).where(eq(oidcStore.userId, s.user.id));
    expect(new Set(rows.filter((r) => r.kind === "Grant").map((r) => r.orgId))).toEqual(
      new Set([s.orgB.id])
    );
  });

  it("refuses an org without membership with org_not_eligible and keeps the old session", async () => {
    const s = await scenario();
    const other = await seedOrg(db);
    expect(await switchTo(s, s.refresh, other.id)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant", error_description: "org_not_eligible" },
    });
    expect(
      (
        await tokenRequest(s.app.clientId, s.secret, {
          grant_type: "refresh_token",
          refresh_token: s.refresh,
        })
      ).status
    ).toBe(200);
  });

  it("refuses a deactivated membership of the target org", async () => {
    const s = await scenario();
    await db
      .update(memberships)
      .set({ isActive: false })
      .where(and(eq(memberships.userId, s.user.id), eq(memberships.orgId, s.orgB.id)));
    expect(await switchTo(s, s.refresh, s.orgB.id)).toMatchObject({
      body: { error: "invalid_grant", error_description: "org_not_eligible" },
    });
  });

  it("answers org_not_eligible even when the user has lost access to every org of the app", async () => {
    const s = await scenario();
    await db.update(memberships).set({ isActive: false }).where(eq(memberships.userId, s.user.id));
    expect(await switchTo(s, s.refresh, s.orgB.id)).toMatchObject({
      status: 400,
      body: { error: "invalid_grant", error_description: "org_not_eligible" },
    });
  });

  it("refuses an inactive user with invalid_credentials", async () => {
    const s = await scenario();
    await db.update(users).set({ isActive: false }).where(eq(users.id, s.user.id));
    expect(await switchTo(s, s.refresh, s.orgB.id)).toMatchObject({
      body: { error: "invalid_grant", error_description: "invalid_credentials" },
    });
  });

  it("refuses a refresh token of another client", async () => {
    const s = await scenario();
    const { app: y, secret: ySecret } = await seedClient(db, key, { allowedGrants: ["password"] });
    expect(
      await tokenRequest(y.clientId, ySecret, {
        grant_type: SWITCH,
        refresh_token: s.refresh,
        org_id: s.orgB.id,
      })
    ).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    // Still usable by its owner.
    expect((await switchTo(s, s.refresh, s.orgB.id)).status).toBe(200);
  });

  it("refuses an unknown refresh token and a reused one, revoking the grant on reuse", async () => {
    const s = await scenario();
    expect(await switchTo(s, "nope", s.orgB.id)).toMatchObject({
      body: { error: "invalid_grant" },
    });
    const first = await switchTo(s, s.refresh, s.orgB.id);
    expect(first.status).toBe(200);
    expect((await switchTo(s, s.refresh, s.orgA.id)).status).toBe(400);
  });

  it("requires refresh_token and org_id", async () => {
    const s = await scenario();
    expect(
      await tokenRequest(s.app.clientId, s.secret, { grant_type: SWITCH, org_id: s.orgB.id })
    ).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(
      await tokenRequest(s.app.clientId, s.secret, { grant_type: SWITCH, refresh_token: s.refresh })
    ).toMatchObject({ status: 400, body: { error: "invalid_request" } });
  });
});
