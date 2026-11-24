import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { resolveAccess } from "../access/permissions.js";
import { bootstrap, readBootstrapEnv } from "../bootstrap.js";
import type { Db } from "../db/client.js";
import {
  appPermissions,
  apps,
  memberships,
  orgApps,
  organizations,
  rolePermissions,
  roles,
  users,
} from "../db/schema/index.js";
import { decryptSecret } from "../oidc/secrets.js";
import { verifyPassword } from "../users/passwords.js";
import { createTestDb } from "./db.js";

const secretKey = randomBytes(32);
const params = {
  adminEmail: "root@example.com",
  adminPassword: "correct-horse-battery",
  adminRedirectUris: ["http://localhost:3001/auth/callback"],
  adminPostLogoutRedirectUris: ["http://localhost:3001/login"],
  adminClientId: "monexa-admin",
  secretKey,
};
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("bootstrap", () => {
  it("is idempotent and returns the client secret only on creation", async () => {
    const first = await bootstrap(db, params);
    const second = await bootstrap(db, params);

    expect(first.adminClientSecret).toEqual(expect.any(String));
    expect(second.adminClientSecret).toBeNull();

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(apps)).toHaveLength(1);
    expect(await db.select().from(roles)).toHaveLength(1);
    expect(await db.select().from(organizations)).toHaveLength(1);
    expect(await db.select().from(memberships)).toHaveLength(1);
    expect(await db.select().from(orgApps)).toHaveLength(1);
  });

  it("creates the sso-only admin app with the secret stored encrypted", async () => {
    const [app] = await db.select().from(apps).where(eq(apps.clientId, "monexa-admin"));
    expect(app?.allowedGrants).toEqual(["authorization_code"]);
    expect(app?.redirectUris).toEqual(params.adminRedirectUris);
    expect(app?.postLogoutRedirectUris).toEqual(["http://localhost:3001/login"]);
    expect(app?.clientSecretEnc).not.toBe("");
    expect(decryptSecret(app?.clientSecretEnc as string, secretKey)).toHaveLength(43);

    const catalog = await db.select().from(appPermissions);
    expect(catalog.map((c) => c.permission).sort()).toEqual([
      "org.activity:view",
      "org.branding:manage",
      "org.member:manage",
      "org.role:assign",
      "platform:all",
    ]);
    const [role] = await db.select().from(roles);
    expect(role?.name).toBe("Org Admin");
    const perms = await db.select().from(rolePermissions);
    expect(perms.map((p) => p.permission).sort()).toEqual([
      "org.activity:view",
      "org.branding:manage",
      "org.member:manage",
      "org.role:assign",
    ]);
  });

  it("creates a platform admin with a verifiable password, member of Monexa", async () => {
    const [admin] = await db.select().from(users);
    expect(admin).toMatchObject({ email: "root@example.com", isPlatformAdmin: true });
    expect(await verifyPassword(admin?.passwordHash as string, params.adminPassword)).toBe(true);
    const [org] = await db.select().from(organizations);
    expect(org).toMatchObject({ slug: "monexa", name: "Monexa" });
  });

  it("resolves platform:all in Monexa on the admin app", async () => {
    const [admin] = await db.select().from(users);
    const [app] = await db.select().from(apps);
    const access = await resolveAccess(db, {
      userId: admin?.id as string,
      appId: app?.id as string,
      adminClientId: "monexa-admin",
    });
    expect(access).toEqual({
      ok: true,
      org: expect.objectContaining({ name: "Monexa" }),
      permissions: ["platform:all"],
    });
  });

  it("repairs a demoted existing user without changing the password", async () => {
    await db.update(users).set({ isPlatformAdmin: false, isActive: false });
    const [before] = await db.select().from(users);
    await bootstrap(db, { ...params, adminPassword: "another-password-1" });
    const [after] = await db.select().from(users);
    expect(after).toMatchObject({ isPlatformAdmin: true, isActive: true });
    expect(after?.passwordHash).toBe(before?.passwordHash);
  });
});

describe("bootstrap with rotateAdminSecret (lost admin app secret)", () => {
  it("issues a new admin app secret on a repeat run, replacing the stored one", async () => {
    const [before] = await db.select().from(apps).where(eq(apps.clientId, "monexa-admin"));
    const { adminClientSecret } = await bootstrap(db, { ...params, rotateAdminSecret: true });
    expect(adminClientSecret).toEqual(expect.any(String));
    const [after] = await db.select().from(apps).where(eq(apps.clientId, "monexa-admin"));
    expect(decryptSecret(after?.clientSecretEnc as string, secretKey)).toBe(adminClientSecret);
    expect(after?.clientSecretEnc).not.toBe(before?.clientSecretEnc);
    expect((await bootstrap(db, params)).adminClientSecret).toBeNull();
  });

  it("stores a caller-supplied secret, so the caller can save it elsewhere first", async () => {
    const given = randomBytes(32).toString("base64url");
    const { adminClientSecret } = await bootstrap(db, {
      ...params,
      rotateAdminSecret: true,
      adminClientSecret: given,
    });
    expect(adminClientSecret).toBe(given);
    const [row] = await db.select().from(apps).where(eq(apps.clientId, "monexa-admin"));
    expect(decryptSecret(row?.clientSecretEnc as string, secretKey)).toBe(given);
  });

  it("reads BOOTSTRAP_ROTATE_ADMIN_SECRET", () => {
    const env = {
      ADMIN_CLIENT_ID: "monexa-admin",
      CLIENT_SECRET_KEY: secretKey.toString("base64"),
    };
    const base = { BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_PASSWORD: "long-enough-pw" };
    expect(readBootstrapEnv(base, env).rotateAdminSecret).toBe(false);
    expect(
      readBootstrapEnv({ ...base, BOOTSTRAP_ROTATE_ADMIN_SECRET: "true" }, env).rotateAdminSecret
    ).toBe(true);
  });
});

describe("bootstrap post-logout URIs on an existing app", () => {
  it("adds the missing URIs exactly once and never removes any", async () => {
    const { db: own, close: closeOwn } = await createTestDb();
    try {
      await bootstrap(own, { ...params, adminPostLogoutRedirectUris: [] });
      const read = async () =>
        (await own.select().from(apps).where(eq(apps.clientId, "monexa-admin")))[0]
          ?.postLogoutRedirectUris;
      expect(await read()).toEqual([]);
      await own
        .update(apps)
        .set({ postLogoutRedirectUris: ["https://keep.example/out"] })
        .where(eq(apps.clientId, "monexa-admin"));
      await bootstrap(own, params);
      await bootstrap(own, params);
      expect(await read()).toEqual(["https://keep.example/out", "http://localhost:3001/login"]);
    } finally {
      await closeOwn();
    }
  });
});

describe("readBootstrapEnv", () => {
  const env = { ADMIN_CLIENT_ID: "monexa-admin", CLIENT_SECRET_KEY: secretKey.toString("base64") };

  it("defaults the redirect URI and splits a comma list", () => {
    const base = { BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_PASSWORD: "long-enough-pw" };
    expect(readBootstrapEnv(base, env).adminRedirectUris).toEqual([
      "http://localhost:3001/auth/callback",
    ]);
    const listed = readBootstrapEnv(
      { ...base, BOOTSTRAP_ADMIN_REDIRECT_URIS: "http://a/cb, http://b/cb," },
      env
    );
    expect(listed.adminRedirectUris).toEqual(["http://a/cb", "http://b/cb"]);
    expect(listed.secretKey.equals(secretKey)).toBe(true);
  });

  it("defaults the post-logout URI and splits a comma list", () => {
    const base = { BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_PASSWORD: "long-enough-pw" };
    expect(readBootstrapEnv(base, env).adminPostLogoutRedirectUris).toEqual([
      "http://localhost:3001/login",
    ]);
    expect(
      readBootstrapEnv({ ...base, BOOTSTRAP_ADMIN_POST_LOGOUT_REDIRECT_URIS: "http://a/x, ," }, env)
        .adminPostLogoutRedirectUris
    ).toEqual(["http://a/x"]);
  });

  it("rejects missing values and weak passwords without echoing the password", () => {
    expect(() => readBootstrapEnv({}, env)).toThrow("BOOTSTRAP_ADMIN_EMAIL");
    expect(() => readBootstrapEnv({ BOOTSTRAP_ADMIN_EMAIL: "a@b.co" }, env)).toThrow(
      "BOOTSTRAP_ADMIN_PASSWORD"
    );
    expect(() =>
      readBootstrapEnv({ BOOTSTRAP_ADMIN_EMAIL: "a@b.co", BOOTSTRAP_ADMIN_PASSWORD: "short" }, env)
    ).toThrow(/rejected/);
  });
});
