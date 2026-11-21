import { createServer } from "node:net";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
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
import { activityLog } from "../../db/schema/index.js";
import { hashPassword } from "../../users/passwords.js";

const TEMP = "temp-password-1";
const NEXT = "brand new password";

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let issuer: string;
let key: Buffer;
const extra: FastifyInstance[] = [];

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

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  const port = await freePort();
  const env = testEnv({ OIDC_ISSUER: `http://127.0.0.1:${port}` });
  key = Buffer.from(env.CLIENT_SECRET_KEY, "base64");
  issuer = `${env.OIDC_ISSUER}/oidc`;
  app = await buildApp({ env, db });
  await app.listen({ port, host: "127.0.0.1" });
});

afterAll(async () => {
  await Promise.all(extra.map((a) => a.close()));
  await app.close();
  await closeDb();
});

/** GET the form and return its CSRF cookie + hidden token. */
async function openForm(target: FastifyInstance = app) {
  const res = await target.inject({ method: "GET", url: "/account/password" });
  const cookie = String(res.headers["set-cookie"]);
  const token = /name="csrf" value="([^"]+)"/.exec(res.body)?.[1] ?? "";
  return { res, cookie: cookie.split(";")[0] as string, token, setCookie: cookie };
}

async function submit(
  fields: Record<string, string>,
  opts: { cookie?: string; token?: string; target?: FastifyInstance } = {}
) {
  const form = await openForm(opts.target);
  const body = new URLSearchParams({
    csrf: opts.token ?? form.token,
    ...fields,
  });
  return (opts.target ?? app).inject({
    method: "POST",
    url: "/account/password",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(opts.cookie === "" ? {} : { cookie: opts.cookie ?? form.cookie }),
    },
    payload: body.toString(),
  });
}

async function tempUser(mustChange = true) {
  return seedUser(db, { passwordHash: await hashPassword(TEMP), mustChangePassword: mustChange });
}

const fields = (identifier: string, over: Record<string, string> = {}) => ({
  identifier,
  current_password: TEMP,
  new_password: NEXT,
  confirm_password: NEXT,
  ...over,
});

describe("GET /account/password", () => {
  it("renders the form with a strict CSRF cookie and matching hidden field", async () => {
    const { res, setCookie, token } = await openForm();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(token.length).toBeGreaterThan(20);
    expect(setCookie).toContain(`${token}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\/account/);
    expect(res.body).toContain('name="current_password"');
  });
});

describe("POST /account/password", () => {
  it("replaces a temporary password; the password grant then succeeds without password_change_required", async () => {
    const { app: client, secret } = await seedClient(db, key, {
      allowedGrants: ["password"],
    });
    const org = await seedOrg(db);
    const user = await tempUser();
    await enableApp(db, org.id, client.id);
    await addMember(db, user.id, org.id);
    const role = await seedRole(db, client.id, "member", []);
    await assignRole(db, user.id, org.id, role.id);

    const grant = async (password: string) => {
      const res = await fetch(`${issuer}/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${client.clientId}:${secret}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "password",
          username: user.email,
          password,
          scope: "openid",
        }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(await grant(TEMP)).toMatchObject({
      status: 400,
      body: { error_description: "password_change_required" },
    });

    const res = await submit(fields(` ${user.email.toUpperCase()} `));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("berhasil");

    const after = await getUser(db, user.id);
    expect(after.mustChangePassword).toBe(false);
    expect(after.failedLogins).toBe(0);
    const ok = await grant(NEXT);
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBeTruthy();
    expect((await grant(TEMP)).status).toBe(400);

    const rows = await db.select().from(activityLog).where(eq(activityLog.targetId, user.id));
    const changed = rows.filter((r) => r.action === "auth.password.changed");
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(NEXT);
    expect(JSON.stringify(rows)).not.toContain(TEMP);
  });

  it("also works for a user without a pending change", async () => {
    const user = await tempUser(false);
    const res = await submit(fields(user.email));
    expect(res.statusCode).toBe(200);
  });

  it("rejects a wrong current password and counts the failure", async () => {
    const user = await tempUser();
    const res = await submit(fields(user.email, { current_password: "nope-nope-nope" }));
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('role="alert"');
    const after = await getUser(db, user.id);
    expect(after.failedLogins).toBe(1);
    expect(after.mustChangePassword).toBe(true);
  });

  it("answers an unknown identifier like a wrong password and logs nothing about it", async () => {
    const res = await submit(fields("ghost-identifier@example.com"));
    expect(res.statusCode).toBe(401);
    const rows = await db.select().from(activityLog);
    expect(JSON.stringify(rows)).not.toContain("ghost-identifier");
  });

  it("rejects a mismatched confirmation and a too-short password", async () => {
    const user = await tempUser();
    const mismatch = await submit(fields(user.email, { confirm_password: "different one" }));
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body).toContain("Konfirmasi password tidak sama");
    const short = await submit(
      fields(user.email, { new_password: "short", confirm_password: "short" })
    );
    expect(short.statusCode).toBe(400);
    expect(short.body).toContain("minimal 8");
    expect((await getUser(db, user.id)).mustChangePassword).toBe(true);
  });

  it("returns 403 for a missing or wrong CSRF token, changing nothing", async () => {
    const user = await tempUser();
    const noCookie = await submit(fields(user.email), { cookie: "" });
    expect(noCookie.statusCode).toBe(403);
    const wrong = await submit(fields(user.email), { token: "forged-token" });
    expect(wrong.statusCode).toBe(403);
    const noField = await app.inject({
      method: "POST",
      url: "/account/password",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: "monexa_csrf=abc",
      },
      payload: new URLSearchParams(fields(user.email)).toString(),
    });
    expect(noField.statusCode).toBe(403);
    expect(wrong.headers["content-type"]).toContain("text/html");
    expect((await getUser(db, user.id)).mustChangePassword).toBe(true);
  });

  it("renders a 429 page once the per-identifier limit is exceeded", async () => {
    const limited = await buildApp({
      env: testEnv({ LOGIN_RATE_LIMIT_MAX: "2" }),
      db,
    });
    extra.push(limited);
    const bad = fields("limited@example.com", { current_password: "x" });
    const statuses: number[] = [];
    let last = { body: "", type: "" };
    for (let i = 0; i < 3; i++) {
      const res = await submit(bad, { target: limited });
      statuses.push(res.statusCode);
      last = { body: res.body, type: String(res.headers["content-type"]) };
    }
    expect(statuses).toEqual([401, 401, 429]);
    expect(last.type).toContain("text/html");
    expect(last.body).toContain("Terlalu banyak");
    // A different identifier from the same IP is not throttled by it.
    const other = await submit(fields("someone-else@example.com"), { target: limited });
    expect(other.statusCode).toBe(401);
  });
});
