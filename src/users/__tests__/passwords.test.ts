import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const verifySpy = vi.hoisted(() => vi.fn());
vi.mock("@node-rs/argon2", async (orig) => {
  const actual = await orig<typeof import("@node-rs/argon2")>();
  verifySpy.mockImplementation(actual.verify);
  return { ...actual, verify: verifySpy };
});

import { createTestDb } from "../../__tests__/db.js";
import { getUser, seedUser } from "../../__tests__/fixtures.js";
import type { Db } from "../../db/client.js";
import { findUserByIdentifier } from "../lookup.js";
import { checkPasswordLogin, hashPassword, verifyPassword } from "../passwords.js";

let db: Db;
let close: () => Promise<void>;
const opts = { maxFailures: 5, lockMinutes: 15 };

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(() => close());

describe("argon2", () => {
  it("round trips and never stores the plain text", async () => {
    const hash = await hashPassword("s3cret-pass");
    expect(hash).not.toContain("s3cret-pass");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "s3cret-pass")).toBe(true);
    expect(await verifyPassword(hash, "other")).toBe(false);
  });
});

describe("findUserByIdentifier", () => {
  it("trims and matches email or username case-insensitively", async () => {
    const u = await seedUser(db, { email: "Ada@Example.com", username: "AdaL" });
    expect((await findUserByIdentifier(db, "  ada@example.COM "))?.id).toBe(u.id);
    expect((await findUserByIdentifier(db, " adal"))?.id).toBe(u.id);
    expect(await findUserByIdentifier(db, "nobody")).toBeNull();
    expect(await findUserByIdentifier(db, "   ")).toBeNull();
  });
});

describe("checkPasswordLogin", () => {
  it("succeeds with the right password and resets the counter", async () => {
    const u = await seedUser(db, { passwordHash: await hashPassword("pw-1234"), failedLogins: 2 });
    const r = await checkPasswordLogin(db, u.email, "pw-1234", opts);
    expect(r).toMatchObject({ ok: true, user: { id: u.id } });
    expect((await getUser(db, u.id)).failedLogins).toBe(0);
  });

  it("rejects unknown users, wrong passwords, and users without a hash", async () => {
    expect(await checkPasswordLogin(db, "ghost@example.com", "x", opts)).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    const noHash = await seedUser(db, { passwordHash: null });
    expect(await checkPasswordLogin(db, noHash.email, "x", opts)).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    const u = await seedUser(db, { passwordHash: await hashPassword("right-pw") });
    expect(await checkPasswordLogin(db, u.email, "wrong", opts)).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    expect((await getUser(db, u.id)).failedLogins).toBe(1);
  });

  it("locks after maxFailures, rejects the right password while locked, then recovers", async () => {
    const u = await seedUser(db, { passwordHash: await hashPassword("right-pw") });
    const now = new Date("2026-01-01T00:00:00Z");
    for (let i = 0; i < 4; i++) await checkPasswordLogin(db, u.email, "bad", { ...opts, now });
    expect((await getUser(db, u.id)).lockedUntil).toBeNull();
    await checkPasswordLogin(db, u.email, "bad", { ...opts, now });
    const locked = await getUser(db, u.id);
    expect(locked.failedLogins).toBe(5);
    expect(locked.lockedUntil?.toISOString()).toBe("2026-01-01T00:15:00.000Z");

    const during = await checkPasswordLogin(db, u.email, "right-pw", {
      ...opts,
      now: new Date("2026-01-01T00:10:00Z"),
    });
    expect(during).toEqual({ ok: false, reason: "invalid_credentials" });

    const after = await checkPasswordLogin(db, u.email, "right-pw", {
      ...opts,
      now: new Date("2026-01-01T00:16:00Z"),
    });
    expect(after.ok).toBe(true);
    const reset = await getUser(db, u.id);
    expect(reset.failedLogins).toBe(0);
    expect(reset.lockedUntil).toBeNull();
  });

  it("treats an inactive user as invalid even with the right password", async () => {
    const u = await seedUser(db, { passwordHash: await hashPassword("pw-1234"), isActive: false });
    expect(await checkPasswordLogin(db, u.email, "pw-1234", opts)).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("asks for a password change only after the password verified", async () => {
    const u = await seedUser(db, {
      passwordHash: await hashPassword("pw-1234"),
      mustChangePassword: true,
    });
    expect(await checkPasswordLogin(db, u.email, "pw-1234", opts)).toEqual({
      ok: false,
      reason: "password_change_required",
    });
    expect(await checkPasswordLogin(db, u.email, "wrong", opts)).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("uses the default clock when now is omitted", async () => {
    const u = await seedUser(db, { passwordHash: await hashPassword("pw-1234") });
    expect((await checkPasswordLogin(db, u.email, "pw-1234", opts)).ok).toBe(true);
  });

  it("starts a fresh failure window after a lock expires", async () => {
    const u = await seedUser(db, { passwordHash: await hashPassword("right-pw") });
    const now = new Date("2026-02-01T00:00:00Z");
    for (let i = 0; i < 5; i++) await checkPasswordLogin(db, u.email, "bad", { ...opts, now });
    const later = new Date("2026-02-01T00:20:00Z");
    await checkPasswordLogin(db, u.email, "bad", { ...opts, now: later });
    const one = await getUser(db, u.id);
    expect(one.failedLogins).toBe(1);
    expect(one.lockedUntil).toBeNull();
    for (let i = 0; i < 4; i++)
      await checkPasswordLogin(db, u.email, "bad", { ...opts, now: later });
    const again = await getUser(db, u.id);
    expect(again.failedLogins).toBe(5);
    expect(again.lockedUntil).not.toBeNull();
  });

  it("counts at most maxFailures verifications of parallel wrong guesses, then the account is locked", async () => {
    const hashed = await hashPassword("right-pw");
    const u = await seedUser(db, { passwordHash: hashed });
    verifySpy.mockClear();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => checkPasswordLogin(db, u.email, "bad", opts))
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    const realVerifies = verifySpy.mock.calls.filter(([h]) => h === hashed).length;
    expect(realVerifies).toBeLessThanOrEqual(opts.maxFailures);
    const after = await getUser(db, u.id);
    expect(after.failedLogins).toBe(opts.maxFailures);
    expect(after.lockedUntil).not.toBeNull();
    expect((await checkPasswordLogin(db, u.email, "right-pw", opts)).ok).toBe(false);
  });

  it("runs a dummy verify for unknown, inactive, passwordless and locked users", async () => {
    const hashed = await hashPassword("pw-1234");
    const inactive = await seedUser(db, { passwordHash: hashed, isActive: false });
    const noHash = await seedUser(db, { passwordHash: null });
    const locked = await seedUser(db, {
      passwordHash: hashed,
      lockedUntil: new Date(Date.now() + 600_000),
    });
    for (const id of ["ghost@example.com", inactive.email, noHash.email, locked.email]) {
      verifySpy.mockClear();
      const r = await checkPasswordLogin(db, id, "pw-1234", opts);
      expect(r).toEqual({ ok: false, reason: "invalid_credentials" });
      expect(verifySpy).toHaveBeenCalledTimes(1);
    }
  });
});
