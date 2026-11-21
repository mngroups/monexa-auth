import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../__tests__/db.js";
import { seedClient, seedOrg, seedUser } from "../../__tests__/fixtures.js";
import type { Db } from "../../db/client.js";
import { oidcStore } from "../../db/schema/index.js";
import { createAdapter } from "../adapter.js";

const key = randomBytes(32);
let db: Db;
let close: () => Promise<void>;
let adapterFor: ReturnType<typeof createAdapter>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  adapterFor = createAdapter(db, { clientSecretKey: key });
});
afterAll(async () => close());

async function row(kind: string, id: string) {
  const [r] = await db
    .select()
    .from(oidcStore)
    .where(and(eq(oidcStore.kind, kind), eq(oidcStore.id, id)));
  return r;
}

describe("oidc adapter", () => {
  it("upserts and finds a payload, replacing it on a second upsert", async () => {
    const sessions = adapterFor("Session");
    await sessions.upsert("s1", { uid: "u1", jti: "s1" }, 60);
    expect(await sessions.find("s1")).toEqual({ uid: "u1", jti: "s1" });
    await sessions.upsert("s1", { uid: "u2", jti: "s1" }, 60);
    expect(await sessions.find("s1")).toEqual({ uid: "u2", jti: "s1" });
    expect(await sessions.findByUid("u2")).toEqual({ uid: "u2", jti: "s1" });
    expect(await sessions.findByUid("u1")).toBeUndefined();
    // Kinds are separate namespaces.
    expect(await adapterFor("Interaction").find("s1")).toBeUndefined();
  });

  it("never returns expired rows", async () => {
    const codes = adapterFor("AuthorizationCode");
    await codes.upsert("c-old", { jti: "c-old", uid: "old" }, 60);
    await db
      .update(oidcStore)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(oidcStore.id, "c-old"));
    expect(await codes.find("c-old")).toBeUndefined();
    expect(await codes.findByUid("old")).toBeUndefined();
  });

  it("keeps rows without an expiry", async () => {
    await adapterFor("Grant").upsert("g-forever", { jti: "g-forever" });
    expect(await adapterFor("Grant").find("g-forever")).toEqual({ jti: "g-forever" });
  });

  it("marks a row consumed once; consuming it again throws invalid_grant", async () => {
    const tokens = adapterFor("RefreshToken");
    await tokens.upsert("rt1", { jti: "rt1", grantId: "g1" }, 60);
    await tokens.consume("rt1");
    const found = await tokens.find("rt1");
    expect(found).toMatchObject({ jti: "rt1", grantId: "g1" });
    expect(typeof found?.consumed).toBe("number");
    await expect(tokens.consume("rt1")).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("destroys a row and revokes every row of a grant", async () => {
    const tokens = adapterFor("RefreshToken");
    await tokens.upsert("rt-a", { jti: "rt-a", grantId: "g-x" }, 60);
    await tokens.upsert("rt-b", { jti: "rt-b", grantId: "g-x" }, 60);
    await tokens.upsert("rt-c", { jti: "rt-c", grantId: "g-y" }, 60);
    await adapterFor("AccessToken").upsert("at-a", { jti: "at-a", grantId: "g-x" }, 60);
    await tokens.destroy("rt-c");
    expect(await tokens.find("rt-c")).toBeUndefined();
    await tokens.revokeByGrantId("g-x");
    expect(await tokens.find("rt-a")).toBeUndefined();
    expect(await tokens.find("rt-b")).toBeUndefined();
    // Only this kind is revoked; the provider calls each model in turn.
    expect(await adapterFor("AccessToken").find("at-a")).toBeDefined();
  });

  it("denormalises user and org: Grant from its payload, tokens from their grant", async () => {
    const user = await seedUser(db);
    const org = await seedOrg(db);
    await adapterFor("Grant").upsert(
      "g-org",
      { jti: "g-org", accountId: user.id, orgId: org.id } as never,
      60
    );
    await adapterFor("RefreshToken").upsert(
      "rt-org",
      { jti: "rt-org", accountId: user.id, grantId: "g-org" },
      60
    );
    await adapterFor("Session").upsert("s-org", { jti: "s-org", accountId: user.id }, 60);
    expect(await row("Grant", "g-org")).toMatchObject({ userId: user.id, orgId: org.id });
    expect(await row("RefreshToken", "rt-org")).toMatchObject({
      userId: user.id,
      orgId: org.id,
      grantId: "g-org",
    });
    expect(await row("Session", "s-org")).toMatchObject({ userId: user.id, orgId: null });
  });

  it("finds by user code", async () => {
    await adapterFor("DeviceCode").upsert("d1", { jti: "d1", userCode: "ABCD" }, 60);
    expect(await adapterFor("DeviceCode").findByUserCode("ABCD")).toMatchObject({ jti: "d1" });
    expect(await adapterFor("DeviceCode").findByUserCode("ZZZZ")).toBeUndefined();
  });

  it("reads kind Client from active apps, with the decrypted secret", async () => {
    const { app, secret } = await seedClient(db, key, {
      allowedGrants: ["password", "authorization_code"],
      redirectUris: ["https://app.example.com/cb"],
      postLogoutRedirectUris: ["https://app.example.com/"],
      accessTtlSeconds: 300,
      refreshTtlSeconds: 3600,
    });
    expect(await adapterFor("Client").find(app.clientId)).toEqual({
      client_id: app.clientId,
      client_secret: secret,
      client_name: app.name,
      redirect_uris: ["https://app.example.com/cb"],
      post_logout_redirect_uris: ["https://app.example.com/"],
      grant_types: ["password", "authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      app_id: app.id,
      access_ttl_seconds: 300,
      refresh_ttl_seconds: 3600,
    });

    const { app: passwordOnly } = await seedClient(db, key, { allowedGrants: ["password"] });
    expect(await adapterFor("Client").find(passwordOnly.clientId)).toMatchObject({
      grant_types: ["password", "refresh_token"],
      response_types: [],
    });

    const { app: inactive } = await seedClient(db, key, { isActive: false });
    expect(await adapterFor("Client").find(inactive.clientId)).toBeUndefined();
    expect(await adapterFor("Client").find("nope")).toBeUndefined();
  });
});
