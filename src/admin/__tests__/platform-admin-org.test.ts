import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createTestDb } from "../../__tests__/db.js";
import { addMember, seedOrg, seedUser } from "../../__tests__/fixtures.js";
import { testEnv } from "../../__tests__/helpers.js";
import { resolveAccess } from "../../access/permissions.js";
import { buildApp } from "../../app.js";
import { bootstrap } from "../../bootstrap.js";
import type { Db } from "../../db/client.js";
import { apps, organizations, roles, users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { mintToken } from "./harness.js";

let db: Db;
let closeDb: () => Promise<void>;
let env: Env;
let app: FastifyInstance;
let adminAppId: string;
let monexaId: string;
let orgAdminRoleId: string;
let rootId: string;

/** The admin-app token the provider would issue: permissions straight from `resolveAccess`. */
async function realToken(userId: string, orgId: string) {
  const access = await resolveAccess(db, {
    userId,
    appId: adminAppId,
    orgId,
    adminClientId: env.ADMIN_CLIENT_ID,
  });
  if (!access.ok) throw new Error(`no access: ${access.reason}`);
  return {
    permissions: access.permissions,
    token: await mintToken(env, { sub: userId, orgId, permissions: access.permissions }),
  };
}

const call = (token: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
  app.inject({
    method,
    url: `/api/admin/org${url}`,
    payload,
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  env = testEnv();
  app = await buildApp({ env, db });
  await bootstrap(db, {
    adminEmail: "root@example.com",
    adminPassword: "correct-horse-battery",
    adminRedirectUris: ["http://localhost:3001/auth/callback"],
    adminClientId: env.ADMIN_CLIENT_ID,
    secretKey: Buffer.from(env.CLIENT_SECRET_KEY, "base64"),
  });
  [{ id: adminAppId }] = (await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.clientId, env.ADMIN_CLIENT_ID))) as [{ id: string }];
  [{ id: monexaId }] = (await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, "monexa"))) as [{ id: string }];
  [{ id: orgAdminRoleId }] = (await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, "Org Admin"))) as [{ id: string }];
  [{ id: rootId }] = (await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, "root@example.com"))) as [{ id: string }];
});

afterAll(async () => {
  await app.close();
  await closeDb();
});

describe("a bootstrapped platform admin in an org", () => {
  it("creates a member, makes them Org Admin, and the member's own token then reaches org routes", async () => {
    const root = await realToken(rootId, monexaId);
    expect(root.permissions).toEqual(["platform:all"]);

    const created = await call(root.token, "POST", "/members", {
      email: "first.admin@example.com",
      name: "First Admin",
      temporaryPassword: "temp-pass-123",
    });
    expect(created.statusCode).toBe(200);
    const memberId = created.json().data.userId as string;

    const assigned = await call(root.token, "PUT", `/members/${memberId}/roles`, {
      roleIds: [orgAdminRoleId],
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json().data.roles).toEqual([
      expect.objectContaining({ id: orgAdminRoleId, name: "Org Admin" }),
    ]);
    expect((await call(root.token, "GET", "/activity")).statusCode).toBe(200);

    const member = await realToken(memberId, monexaId);
    expect(member.permissions).toEqual([
      "org.activity:view",
      "org.branding:manage",
      "org.member:manage",
      "org.role:assign",
    ]);
    const listed = await call(member.token, "GET", "/members");
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.items.map((m: { userId: string }) => m.userId)).toContain(memberId);
  });

  it("acts on platform admins and multi-org users, but never on itself", async () => {
    const root = await realToken(rootId, monexaId);
    const other = await seedOrg(db);
    const multi = await seedUser(db);
    await addMember(db, multi.id, monexaId);
    await addMember(db, multi.id, other.id);
    const reset = await call(root.token, "POST", `/members/${multi.id}/reset-password`, {
      temporaryPassword: "reset-pass-123",
    });
    expect(reset.statusCode).toBe(200);

    const peer = await seedUser(db, { isPlatformAdmin: true });
    await addMember(db, peer.id, monexaId);
    const peerRoles = await call(root.token, "PUT", `/members/${peer.id}/roles`, {
      roleIds: [orgAdminRoleId],
    });
    expect(peerRoles.statusCode).toBe(200);

    for (const res of [
      await call(root.token, "PUT", `/members/${rootId}/roles`, { roleIds: [orgAdminRoleId] }),
      await call(root.token, "POST", `/members/${rootId}/deactivate`),
      await call(root.token, "POST", `/members/${rootId}/reset-password`, {
        temporaryPassword: "reset-pass-123",
      }),
    ]) {
      expect(res.statusCode).toBe(422);
      expect(res.json().message).toBe(MESSAGES_AUTH.selfActionNotAllowed);
    }
  });

  it("loses the platform bypass the moment is_platform_admin is cleared", async () => {
    const other = await seedUser(db, { isPlatformAdmin: true });
    const { token } = await realToken(other.id, monexaId);
    await db.update(users).set({ isPlatformAdmin: false }).where(eq(users.id, other.id));
    expect((await call(token, "GET", "/members")).statusCode).toBe(403);
  });
});
