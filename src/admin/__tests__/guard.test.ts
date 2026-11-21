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
