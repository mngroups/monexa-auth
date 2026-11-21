import { eq } from "drizzle-orm";
import { createTestDb } from "../../__tests__/db.js";
import { seedApp, seedOrg, seedUser } from "../../__tests__/fixtures.js";
import type { Db } from "../../db/client.js";
import { oidcStore } from "../../db/schema/index.js";
import { revokeGrants } from "../revoke.js";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

/** A grant with one access token, refresh token and code, plus the user's session. */
async function issue(userId: string, orgId: string, clientId: string, tag: string) {
  const grantId = `g-${tag}`;
  const base = { grantId, userId, orgId };
  const payload = { clientId, accountId: userId };
  await db.insert(oidcStore).values([
    { id: grantId, kind: "Grant", payload, userId, orgId },
    { id: `at-${tag}`, kind: "AccessToken", payload, ...base },
    { id: `rt-${tag}`, kind: "RefreshToken", payload, ...base },
    { id: `ac-${tag}`, kind: "AuthorizationCode", payload, ...base },
  ]);
  return grantId;
}

async function ids(userId: string) {
  const rows = await db
    .select({ id: oidcStore.id })
    .from(oidcStore)
    .where(eq(oidcStore.userId, userId));
  return rows.map((r) => r.id).sort();
}

async function scenario() {
  const user = await seedUser(db);
  const [orgA, orgB] = [await seedOrg(db), await seedOrg(db)];
  const [appX, appY] = [await seedApp(db), await seedApp(db)];
  const t = user.id.slice(0, 8);
  await issue(user.id, orgA.id, appX.clientId, `${t}-ax`);
  await issue(user.id, orgA.id, appY.clientId, `${t}-ay`);
  await issue(user.id, orgB.id, appX.clientId, `${t}-bx`);
  await db.insert(oidcStore).values({
    id: `s-${t}`,
    kind: "Session",
    payload: { accountId: user.id },
    userId: user.id,
  });
  return { user, orgA, orgB, appX, appY, t };
}

describe("revokeGrants", () => {
  it("by user: removes every grant, token, code and session of the user only", async () => {
    const { user, t } = await scenario();
    const other = await seedUser(db);
    await issue(other.id, (await seedOrg(db)).id, "x", `other-${t}`);
    expect(await revokeGrants(db, { userId: user.id })).toBe(3);
    expect(await ids(user.id)).toEqual([]);
    expect(await ids(other.id)).toHaveLength(4);
  });

  it("by user + org: keeps the user's other orgs and the session", async () => {
    const { user, orgA, t } = await scenario();
    expect(await revokeGrants(db, { userId: user.id, orgId: orgA.id })).toBe(2);
    expect(await ids(user.id)).toEqual(
      [`ac-${t}-bx`, `at-${t}-bx`, `g-${t}-bx`, `rt-${t}-bx`, `s-${t}`].sort()
    );
  });

  it("by user + app: keeps the user's other apps", async () => {
    const { user, appX, t } = await scenario();
    expect(await revokeGrants(db, { userId: user.id, appId: appX.id })).toBe(2);
    expect(await ids(user.id)).toEqual(
      [`ac-${t}-ay`, `at-${t}-ay`, `g-${t}-ay`, `rt-${t}-ay`, `s-${t}`].sort()
    );
  });

  it("by org + app without a user: revokes it for every user of that org and app", async () => {
    const { user, orgA, appX, t } = await scenario();
    const second = await seedUser(db);
    await issue(second.id, orgA.id, appX.clientId, `second-${t}`);
    expect(await revokeGrants(db, { orgId: orgA.id, appId: appX.id })).toBe(2);
    expect(await ids(second.id)).toEqual([]);
    expect(await ids(user.id)).toContain(`g-${t}-ay`);
    expect(await ids(user.id)).toContain(`g-${t}-bx`);
  });

  it("refuses to run without any filter", async () => {
    await expect(revokeGrants(db, {})).rejects.toThrow();
  });

  it("returns 0 for an unknown app", async () => {
    const { user } = await scenario();
    expect(
      await revokeGrants(db, { userId: user.id, appId: "00000000-0000-4000-8000-000000000000" })
    ).toBe(0);
  });
});
