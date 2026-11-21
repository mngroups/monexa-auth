import { eq } from "drizzle-orm";
import { addMember, seedOrg, seedUser } from "../../__tests__/fixtures.js";
import { memberships } from "../../db/schema/index.js";
import { type Admin, bootAdmin, mintToken } from "./harness.js";

let h: Admin;
beforeAll(async () => {
  h = await bootAdmin();
});
afterAll(async () => h.close());

const list = (token?: string) =>
  h.app.inject({
    url: "/api/admin/platform/orgs",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

describe("requireAdmin", () => {
  it("lets an admin-app token with platform:all through and exposes request.admin", async () => {
    const res = await list(h.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
  });

  it("returns 401 without a token", async () => {
    expect((await list()).statusCode).toBe(401);
  });

  it("returns 401 for another client's token, even with platform:all", async () => {
    const other = await mintToken(h.env, { sub: h.user.id, clientId: "some-app" });
    expect((await list(other)).statusCode).toBe(401);
  });

  it("returns 401 when client_id is the admin app but aud is not, and vice versa", async () => {
    const badAud = await mintToken(h.env, { sub: h.user.id, aud: "some-app" });
    expect((await list(badAud)).statusCode).toBe(401);
    const badClient = await mintToken(h.env, {
      sub: h.user.id,
      clientId: "some-app",
      aud: h.env.ADMIN_CLIENT_ID,
    });
    expect((await list(badClient)).statusCode).toBe(401);
  });

  it("returns 401 for a garbage token", async () => {
    expect((await list("not-a-jwt")).statusCode).toBe(401);
  });

  it("returns 403 when the token lacks platform:all, including role permissions of the admin app", async () => {
    const none = await mintToken(h.env, { sub: h.user.id, permissions: [] });
    expect((await list(none)).statusCode).toBe(403);
    const memberOnly = await mintToken(h.env, {
      sub: h.user.id,
      permissions: ["org.member:manage"],
    });
    expect((await list(memberOnly)).statusCode).toBe(403);
  });

  it("checks auth before validating the request", async () => {
    const res = await h.app.inject({ url: "/api/admin/platform/orgs?page=0" });
    expect(res.statusCode).toBe(401);
  });
});

describe("requireAdmin re-checks the database", () => {
  it("returns 401 for a still-valid token of a deactivated user", async () => {
    const user = await seedUser(h.db, { isPlatformAdmin: true, isActive: false });
    const token = await mintToken(h.env, { sub: user.id });
    expect((await list(token)).statusCode).toBe(401);
  });

  it("returns 401 for a token of a user that no longer exists", async () => {
    const token = await mintToken(h.env, { sub: "00000000-0000-4000-8000-0000000000aa" });
    expect((await list(token)).statusCode).toBe(401);
  });

  it("returns 403 on platform routes once platform admin was revoked, though the token says platform:all", async () => {
    const user = await seedUser(h.db, { isPlatformAdmin: false });
    const token = await mintToken(h.env, { sub: user.id });
    expect((await list(token)).statusCode).toBe(403);
  });

  it("returns 403 on org routes when the membership of the token's org is inactive or missing", async () => {
    const org = await seedOrg(h.db);
    const user = await seedUser(h.db);
    await addMember(h.db, user.id, org.id, false);
    const token = await mintToken(h.env, {
      sub: user.id,
      orgId: org.id,
      permissions: ["org.member:manage"],
    });
    const members = (bearer: string) =>
      h.app.inject({
        url: "/api/admin/org/members",
        headers: { authorization: `Bearer ${bearer}` },
      });
    expect((await members(token)).statusCode).toBe(403);
    const stranger = await seedUser(h.db);
    const strangerToken = await mintToken(h.env, {
      sub: stranger.id,
      orgId: org.id,
      permissions: ["org.member:manage"],
    });
    expect((await members(strangerToken)).statusCode).toBe(403);
    await h.db.update(memberships).set({ isActive: true }).where(eq(memberships.userId, user.id));
    expect((await members(token)).statusCode).toBe(200);
  });
});
