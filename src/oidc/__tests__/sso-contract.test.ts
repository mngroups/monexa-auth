import { createServer } from "node:net";
import { auth, envelope, errorHandler, MESSAGES } from "@mono/server-kit";
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
import { activityLog, apps as appsTable, memberships, users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { hashPassword } from "../../users/passwords.js";

const PASSWORD = "correct horse battery";
const CATALOG = ["example.item:view", "example.item:edit"];
const FE_CALLBACK = "https://app.example.com/auth/callback";
const FE_LOGGED_OUT = "https://app.example.com/logged-out";

let db: Db;
let closeDb: () => Promise<void>;
let env: Env;
let key: Buffer;
let server: FastifyInstance;
let origin: string;
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

/** A browser: carries cookies between requests and never follows redirects on its own. */
class Browser {
  private readonly cookies = new Map<string, string>();

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const res = await fetch(new URL(url, origin), {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) },
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = line.split(";");
      const name = pair.slice(0, pair.indexOf("=")).trim();
      const value = pair.slice(pair.indexOf("=") + 1).trim();
      const expired = attrs.some((a) => {
        const [k = "", v = ""] = a.split("=");
        return k.trim().toLowerCase() === "expires" && new Date(v) <= new Date();
      });
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get(url: string) {
    return this.request(url);
  }

  post(url: string, fields: Record<string, string>) {
    return this.request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }
}

function location(res: Response): string {
  const value = res.headers.get("location");
  if (!value) throw new Error(`expected a redirect, got ${res.status}`);
  return new URL(value, origin).toString();
}

/** A Monexa backend: the real kit `auth` plugin in sso mode against monexa-auth. */
async function kitApp(clientId: string, clientSecret: string) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(envelope);
  await app.register(errorHandler);
  await app.register(auth, {
    mode: "sso",
    issuer,
    clientId,
    clientSecret,
    redirectUris: [FE_CALLBACK],
    postLogoutRedirectUri: FE_LOGGED_OUT,
    jwksCooldownMs: 0,
  });
  kits.push(app);
  return app;
}

/** An sso app enabled in two orgs; the user is a member of both, last used org B. */
async function scenario() {
  const { app, secret } = await seedClient(
    db,
    key,
    {
      allowedGrants: ["authorization_code"],
      redirectUris: [FE_CALLBACK],
      postLogoutRedirectUris: [FE_LOGGED_OUT],
      refreshTtlSeconds: 3600,
      accessTtlSeconds: 300,
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
  const editor = await seedRole(db, app.id, "editor", ["example.item:edit"]);
  await assignRole(db, user.id, orgA.id, viewer.id);
  await assignRole(db, user.id, orgB.id, editor.id);
  const kit = await kitApp(app.clientId, secret);
  return { app, orgA, orgB, user, kit };
}

/** Kit authorize-url, then the browser opens it: the redirect to the interaction (or the FE). */
async function authorize(b: Browser, kit: FastifyInstance, extra: Record<string, string> = {}) {
  const res = await kit.inject({
    url: `/v1/auth/authorize-url?redirect_uri=${encodeURIComponent(FE_CALLBACK)}`,
  });
  expect(res.statusCode).toBe(200);
  const { url, state, code_verifier } = res.json().data;
  const target = new URL(url);
  for (const [k, v] of Object.entries(extra)) target.searchParams.set(k, v);
  const opened = await b.get(target.toString());
  expect(opened.status).toBe(303);
  return { next: location(opened), state: state as string, verifier: code_verifier as string };
}

/** Follows a finished interaction back through the provider to the FE callback; returns the code. */
async function codeFrom(b: Browser, res: Response, state: string): Promise<string> {
  let current = res;
  for (let hops = 0; hops < 5; hops++) {
    expect([302, 303]).toContain(current.status);
    const next = location(current);
    if (next.startsWith(FE_CALLBACK)) {
      const params = new URL(next).searchParams;
      expect(params.get("state")).toBe(state);
      return params.get("code") as string;
    }
    current = await b.get(next);
  }
  throw new Error("never reached the FE callback");
}

async function exchange(kit: FastifyInstance, code: string, verifier: string) {
  return kit.inject({
    method: "POST",
    url: "/v1/auth/callback",
    payload: { code, code_verifier: verifier, redirect_uri: FE_CALLBACK },
  });
}

function uidOf(interactionUrl: string): string {
  return new URL(interactionUrl).pathname.split("/").pop() as string;
}

const login = (url: string, identifier: string, password = PASSWORD) => ({
  uid: uidOf(url),
  step: "login",
  identifier,
  password,
});

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  passwordHash = await hashPassword(PASSWORD);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  env = testEnv({ OIDC_ISSUER: origin });
  key = Buffer.from(env.CLIENT_SECRET_KEY, "base64");
  issuer = `${origin}/oidc`;
  server = await buildApp({ env, db });
  await server.listen({ port, host: "127.0.0.1" });
});

afterAll(async () => {
  await Promise.all(kits.map((k) => k.close()));
  await server.close();
  await closeDb();
});

describe("sso contract (kit auth plugin in sso mode → monexa-auth interactions)", () => {
  it("logs in, picks org B from the picker and hands the kit tokens for org B", async () => {
    const { app, orgA, orgB, user, kit } = await scenario();
    const b = new Browser();
    const { next, state, verifier } = await authorize(b, kit);
    expect(next).toMatch(new RegExp(`^${origin}/interaction/[\\w-]+$`));

    const page = await b.get(next);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const loginHtml = await page.text();
    expect(loginHtml).toContain('name="identifier"');
    expect(loginHtml).toContain('name="password"');
    expect(loginHtml).toContain(`value="${uidOf(next)}"`);
    expect(loginHtml).toContain("/assets/monexa-theme.css");

    const picker = await b.post(next, login(next, user.email));
    expect(picker.status).toBe(200);
    const pickerHtml = await picker.text();
    expect(pickerHtml).toContain("Alpha");
    expect(pickerHtml).toContain("Beta");
    expect(pickerHtml).toMatch(new RegExp(`value="${orgB.id}"[^>]*checked`));
    expect(pickerHtml).not.toMatch(new RegExp(`value="${orgA.id}"[^>]*checked`));

    const chosen = await b.post(next, { uid: uidOf(next), step: "select-org", org_id: orgB.id });
    const code = await codeFrom(b, chosen, state);
    const tokens = await exchange(kit, code, verifier);
    expect(tokens.statusCode).toBe(200);
    const data = tokens.json().data;
    expect(data.refresh_expires_in).toBe(3600);
    expect(decodeJwt(data.access_token)).toMatchObject({
      sub: user.id,
      aud: app.clientId,
      azp: app.clientId,
      org_id: orgB.id,
      org_name: "Beta",
      permissions: ["example.item:edit"],
    });

    // The code-flow refresh token keeps the grant's org.
    await db.update(users).set({ lastOrgId: orgA.id }).where(eq(users.id, user.id));
    const refreshed = await kit.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      payload: { refresh_token: data.refresh_token },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(decodeJwt(refreshed.json().data.access_token)).toMatchObject({ org_id: orgB.id });

    const [logged] = await db
      .select()
      .from(activityLog)
      .where(
        and(eq(activityLog.actorUserId, user.id), eq(activityLog.action, "auth.login.succeeded"))
      );
    expect(logged).toMatchObject({ orgId: orgB.id, metadata: { client_id: app.clientId } });
    expect((await getUser(db, user.id)).lastOrgId).toBe(orgA.id);
  });

  it("remembers the picked org as the last used one", async () => {
    const { orgA, user, kit } = await scenario();
    const b = new Browser();
    const { next, state } = await authorize(b, kit);
    await b.get(next);
    await b.post(next, login(next, user.email));
    const chosen = await b.post(next, { uid: uidOf(next), step: "select-org", org_id: orgA.id });
    await codeFrom(b, chosen, state);
    expect((await getUser(db, user.id)).lastOrgId).toBe(orgA.id);
  });

  it("skips the picker for a single-org user", async () => {
    const { orgA, kit } = await scenario();
    const loner = await seedUser(db, { passwordHash });
    await addMember(db, loner.id, orgA.id);
    const b = new Browser();
    const { next, state, verifier } = await authorize(b, kit);
    const done = await b.post(next, login(next, loner.username ?? loner.email));
    const tokens = await exchange(kit, await codeFrom(b, done, state), verifier);
    expect(decodeJwt(tokens.json().data.access_token)).toMatchObject({ org_id: orgA.id });
  });

  it("skips the picker for an eligible org_hint", async () => {
    const { orgA, user, kit } = await scenario();
    const b = new Browser();
    const { next, state, verifier } = await authorize(b, kit, { org_hint: orgA.id });
    const done = await b.post(next, login(next, user.email));
    const tokens = await exchange(kit, await codeFrom(b, done, state), verifier);
    expect(decodeJwt(tokens.json().data.access_token)).toMatchObject({ org_id: orgA.id });
  });

  it("shows the picker for an org_hint the user cannot enter", async () => {
    const { user, kit } = await scenario();
    const other = await seedOrg(db);
    const b = new Browser();
    const { next } = await authorize(b, kit, { org_hint: other.id });
    const res = await b.post(next, login(next, user.email));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="org_id"');
  });

  it("re-renders the picker with an error for an org that is not eligible", async () => {
    const { user, kit } = await scenario();
    const other = await seedOrg(db);
    const b = new Browser();
    const { next } = await authorize(b, kit);
    await b.post(next, login(next, user.email));
    const res = await b.post(next, { uid: uidOf(next), step: "select-org", org_id: other.id });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain(MESSAGES_AUTH.orgNotEligible);
    expect(html).toContain('name="org_id"');
  });

  it("re-renders the login form on a wrong password, without redirecting or leaking it", async () => {
    const { app, user, kit } = await scenario();
    const b = new Browser();
    const { next } = await authorize(b, kit);
    const res = await b.post(next, login(next, user.email, "wrong password"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain(MESSAGES.invalidCredentials);
    expect(html).toContain('name="password"');
    expect(html).not.toContain("wrong password");

    const typed = "my-Password-typed-as-username";
    await b.post(next, login(next, typed, "whatever"));
    const failures = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "auth.login.failed"));
    const mine = failures.filter((r) => r.targetId === user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.metadata).toEqual({ client_id: app.clientId, reason: "invalid_credentials" });
    const unknown = failures.filter((r) => r.actorUserId === null);
    expect(unknown.at(-1)).toMatchObject({ targetId: "unknown" });
    expect(JSON.stringify(failures)).not.toContain(typed);
    expect(JSON.stringify(failures)).not.toContain("wrong password");
  });

  it("re-renders the login form when a field is missing", async () => {
    const { kit } = await scenario();
    const b = new Browser();
    const { next } = await authorize(b, kit);
    const res = await b.post(next, { uid: uidOf(next), step: "login", identifier: "" });
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(MESSAGES.invalidCredentials);
  });

  it("never completes the interaction for an inactive user", async () => {
    const { user, kit } = await scenario();
    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    const b = new Browser();
    const { next } = await authorize(b, kit);
    const res = await b.post(next, login(next, user.email));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(MESSAGES.invalidCredentials);
  });

  it("forces a password change first; bad input re-renders; the new password then works", async () => {
    const { orgA, kit, app } = await scenario();
    const stale = await seedUser(db, { passwordHash, mustChangePassword: true });
    await addMember(db, stale.id, orgA.id);
    const b = new Browser();
    const { next, state, verifier } = await authorize(b, kit);

    const form = await b.post(next, login(next, stale.email));
    expect(form.status).toBe(200);
    const formHtml = await form.text();
    expect(formHtml).toContain(MESSAGES_AUTH.passwordChangeRequired);
    expect(formHtml).toContain('name="new_password"');

    const change = (fields: Record<string, string>) =>
      b.post(next, { uid: uidOf(next), step: "change-password", ...fields });
    const mismatch = await change({
      current_password: PASSWORD,
      new_password: "brand new secret",
      confirm_password: "brand new secreT",
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain(MESSAGES_AUTH.passwordMismatch);
    const short = await change({
      current_password: PASSWORD,
      new_password: "short",
      confirm_password: "short",
    });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain(MESSAGES_AUTH.passwordTooShort);
    const wrongCurrent = await change({
      current_password: "not it at all",
      new_password: "brand new secret",
      confirm_password: "brand new secret",
    });
    expect(wrongCurrent.status).toBe(400);
    expect(await wrongCurrent.text()).toContain(MESSAGES_AUTH.currentPasswordWrong);
    // The org picker cannot be reached before the password is changed.
    const skipped = await b.post(next, { uid: uidOf(next), step: "select-org", org_id: orgA.id });
    expect(skipped.status).toBe(200);
    expect(await skipped.text()).toContain('name="new_password"');

    const done = await change({
      current_password: PASSWORD,
      new_password: "brand new secret",
      confirm_password: "brand new secret",
    });
    const tokens = await exchange(kit, await codeFrom(b, done, state), verifier);
    expect(decodeJwt(tokens.json().data.access_token)).toMatchObject({
      sub: stale.id,
      org_id: orgA.id,
    });
    expect((await getUser(db, stale.id)).mustChangePassword).toBe(false);
    const [changed] = await db
      .select()
      .from(activityLog)
      .where(
        and(eq(activityLog.actorUserId, stale.id), eq(activityLog.action, "auth.password.changed"))
      );
    expect(changed).toMatchObject({ targetId: stale.id, metadata: { client_id: app.clientId } });
    expect(JSON.stringify(changed)).not.toContain("brand new secret");

    // A fresh browser logs in with the new password; the old one is refused.
    const fresh = new Browser();
    const again = await authorize(fresh, kit);
    expect((await fresh.post(again.next, login(again.next, stale.email))).status).toBe(401);
    const ok = await fresh.post(again.next, login(again.next, stale.email, "brand new secret"));
    expect((await codeFrom(fresh, ok, again.state)).length).toBeGreaterThan(0);
  });

  it("shows the no-access error page for an app the user cannot use", async () => {
    const { kit } = await scenario();
    const outsider = await seedUser(db, { passwordHash });
    const b = new Browser();
    const { next } = await authorize(b, kit);
    const res = await b.post(next, login(next, outsider.email));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain(MESSAGES_AUTH.noAppAccess);
  });

  it("rejects a POST for another interaction's uid with 400", async () => {
    const { user, kit } = await scenario();
    const mine = new Browser();
    const theirs = new Browser();
    const a = await authorize(mine, kit);
    const other = await authorize(theirs, kit);
    const res = await mine.post(other.next, login(other.next, user.email));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    // A uid field that does not match the URL is refused too.
    const forged = await mine.post(a.next, {
      ...login(a.next, user.email),
      uid: uidOf(other.next),
    });
    expect(forged.status).toBe(400);
    // Without any interaction cookie.
    expect((await new Browser().get(a.next)).status).toBe(400);
  });

  it("ends the central session through the kit's end_session_url", async () => {
    const { orgA, kit } = await scenario();
    const loner = await seedUser(db, { passwordHash });
    await addMember(db, loner.id, orgA.id);
    const b = new Browser();
    const first = await authorize(b, kit);
    const done = await b.post(first.next, login(first.next, loner.email));
    const tokens = await exchange(kit, await codeFrom(b, done, first.state), first.verifier);

    // With the central session, a new authorize goes straight back to the FE.
    const sso = await authorize(b, kit);
    expect(sso.next.startsWith(`${issuer}/auth/`) || sso.next.startsWith(FE_CALLBACK)).toBe(true);

    const logout = await kit.inject({
      method: "POST",
      url: "/v1/auth/logout",
      payload: { refresh_token: tokens.json().data.refresh_token },
    });
    const endSessionUrl = logout.json().data.end_session_url as string;
    expect(endSessionUrl).toContain(`${issuer}/session/end`);

    const page = await b.get(endSessionUrl);
    expect(page.status).toBe(200);
    const html = await page.text();
    const action = /action="([^"]+)"/.exec(html)?.[1] as string;
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1] as string;
    expect(html).toContain('name="logout" value="yes"');
    expect(html).toContain("/assets/auto-submit.js");
    const confirmed = await b.post(action, { xsrf, logout: "yes" });
    expect(location(confirmed)).toBe(FE_LOGGED_OUT);

    const after = await authorize(b, kit);
    expect(after.next).toMatch(/\/interaction\//);
    expect(await (await b.get(after.next)).text()).toContain('name="password"');
  });

  it("shows the logged-out page when no post_logout_redirect_uri is given", async () => {
    const { orgA, kit } = await scenario();
    const loner = await seedUser(db, { passwordHash });
    await addMember(db, loner.id, orgA.id);
    const b = new Browser();
    const first = await authorize(b, kit);
    await codeFrom(b, await b.post(first.next, login(first.next, loner.email)), first.state);
    const page = await (await b.get(`${issuer}/session/end`)).text();
    const action = /action="([^"]+)"/.exec(page)?.[1] as string;
    const xsrf = /name="xsrf" value="([^"]+)"/.exec(page)?.[1] as string;
    const confirmed = await b.post(action, { xsrf, logout: "yes" });
    const success = await b.get(location(confirmed));
    expect(success.status).toBe(200);
    expect(await success.text()).toContain(MESSAGES_AUTH.loggedOut);
  });

  it("starts a new interaction for another app with the session and only asks for the org", async () => {
    const first = await scenario();
    const b = new Browser();
    const one = await authorize(b, first.kit);
    await b.post(one.next, login(one.next, first.user.email));
    const chosen = await b.post(one.next, {
      uid: uidOf(one.next),
      step: "select-org",
      org_id: first.orgA.id,
    });
    await codeFrom(b, chosen, one.state);

    // A second app in the same orgs: the session skips the login, the picker remains.
    const { app: second, secret } = await seedClient(db, key, {
      allowedGrants: ["authorization_code"],
      redirectUris: [FE_CALLBACK],
    });
    await enableApp(db, first.orgA.id, second.id);
    await enableApp(db, first.orgB.id, second.id);
    const kit2 = await kitApp(second.clientId, secret);
    const two = await authorize(b, kit2);
    const html = await (await b.get(two.next)).text();
    expect(html).toContain('name="org_id"');
    expect(html).not.toContain('name="password"');
    const done = await b.post(two.next, {
      uid: uidOf(two.next),
      step: "select-org",
      org_id: first.orgB.id,
    });
    const tokens = await exchange(kit2, await codeFrom(b, done, two.state), two.verifier);
    expect(decodeJwt(tokens.json().data.access_token)).toMatchObject({
      sub: first.user.id,
      aud: second.clientId,
      org_id: first.orgB.id,
    });
  });

  it("asks for the login again when the session's user was deactivated", async () => {
    const first = await scenario();
    const b = new Browser();
    const one = await authorize(b, first.kit, { org_hint: first.orgA.id });
    await codeFrom(b, await b.post(one.next, login(one.next, first.user.email)), one.state);
    await db.update(users).set({ isActive: false }).where(eq(users.id, first.user.id));
    const again = await authorize(b, first.kit);
    expect(again.next).toMatch(/\/interaction\//);
    expect(await (await b.get(again.next)).text()).toContain('name="password"');
  });

  it("asks for the org again when the session's grant lost its membership", async () => {
    const first = await scenario();
    const b = new Browser();
    const one = await authorize(b, first.kit, { org_hint: first.orgA.id });
    await codeFrom(b, await b.post(one.next, login(one.next, first.user.email)), one.state);
    await db
      .update(memberships)
      .set({ isActive: false })
      .where(and(eq(memberships.userId, first.user.id), eq(memberships.orgId, first.orgA.id)));
    const again = await authorize(b, first.kit);
    expect(again.next).toMatch(/\/interaction\//);
    // Only org B is left, so the interaction finishes without asking.
    const res = await b.get(again.next);
    const tokens = await exchange(first.kit, await codeFrom(b, res, again.state), again.verifier);
    expect(decodeJwt(tokens.json().data.access_token)).toMatchObject({ org_id: first.orgB.id });
  });

  it("runs the interaction again for an org_hint other than the remembered grant's org", async () => {
    const first = await scenario();
    const b = new Browser();
    const one = await authorize(b, first.kit, { org_hint: first.orgA.id });
    await codeFrom(b, await b.post(one.next, login(one.next, first.user.email)), one.state);
    const same = await authorize(b, first.kit, { org_hint: first.orgA.id });
    expect(same.next).not.toMatch(/\/interaction\//);
    const other = await authorize(b, first.kit, { org_hint: first.orgB.id });
    expect(other.next).toMatch(/\/interaction\//);
    const res = await b.get(other.next);
    const tokens = await exchange(first.kit, await codeFrom(b, res, other.state), other.verifier);
    expect(decodeJwt(tokens.json().data.access_token)).toMatchObject({ org_id: first.orgB.id });
  });

  it("asks a session user flagged for a password change to change it first", async () => {
    const first = await scenario();
    const b = new Browser();
    const one = await authorize(b, first.kit, { org_hint: first.orgA.id });
    await codeFrom(b, await b.post(one.next, login(one.next, first.user.email)), one.state);
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, first.user.id));
    const { app: second, secret } = await seedClient(db, key, {
      allowedGrants: ["authorization_code"],
      redirectUris: [FE_CALLBACK],
    });
    await enableApp(db, first.orgA.id, second.id);
    const two = await authorize(b, await kitApp(second.clientId, secret));
    expect(await (await b.get(two.next)).text()).toContain('name="new_password"');
  });

  it("shows an error page when the app was deactivated during the interaction", async () => {
    const { app, user, kit } = await scenario();
    const b = new Browser();
    const { next } = await authorize(b, kit);
    await db.update(appsTable).set({ isActive: false }).where(eq(appsTable.id, app.id));
    const res = await b.post(next, login(next, user.email));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(MESSAGES.badRequest);
    expect((await b.get(next)).status).toBe(400);
  });

  it("serves the theme CSS and renders provider errors as an Indonesian page", async () => {
    const css = await fetch(`${origin}/assets/monexa-theme.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--brand");
    expect((await fetch(`${origin}/assets/nope.css`)).status).toBe(404);

    const res = await fetch(`${issuer}/auth?client_id=nope&response_type=code`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain(MESSAGES.badRequest);
  });

  it("does not restrict form-action, so the post-login redirect to the app is allowed", async () => {
    const res = await fetch(`${origin}/assets/monexa-theme.css`);
    expect(res.headers.get("content-security-policy")).not.toContain("form-action");
  });
});
