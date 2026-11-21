import { hash, verify } from "@node-rs/argon2";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type UserRow, users } from "../db/schema/index.js";
import { findUserByIdentifier } from "./lookup.js";

// @node-rs/argon2 defaults to Argon2id (algorithm 2); passed explicitly as the enum is a const enum.
const ARGON2ID = 2;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: ARGON2ID });
}

export function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain);
}

export type PasswordLoginResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: "invalid_credentials" | "password_change_required" };

let dummyHash: Promise<string> | undefined;

/** Burns one argon2 verify so early rejections cost the same as a wrong password. */
async function equalizeTiming(plain: string): Promise<typeof INVALID> {
  dummyHash ??= hashPassword("monexa-auth-timing-dummy");
  await verifyPassword(await dummyHash, plain);
  return INVALID;
}

const INVALID = { ok: false, reason: "invalid_credentials" } as const;

/**
 * Takes one attempt for the user, atomically: counts it as a failure up front and locks the
 * account when it reaches `maxFailures`, but only while the account is not locked. Concurrent
 * guesses therefore get at most `maxFailures` verifications before the lock. An expired lock
 * starts a fresh failure window: this attempt counts as the first. False when locked.
 */
async function reserveAttempt(
  db: Db,
  userId: string,
  opts: { maxFailures: number; lockMinutes: number },
  now: Date
): Promise<boolean> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const lockUntil = sql`${new Date(now.getTime() + opts.lockMinutes * 60_000).toISOString()}::timestamptz`;
  const expired = sql`(${users.lockedUntil} is not null and ${users.lockedUntil} <= ${at})`;
  const count = sql`(case when ${expired} then 0 else ${users.failedLogins} end) + 1`;
  const reserved = await db
    .update(users)
    .set({
      failedLogins: count,
      lockedUntil: sql`case when ${count} >= ${opts.maxFailures} then ${lockUntil} when ${expired} then null else ${users.lockedUntil} end`,
    })
    .where(and(eq(users.id, userId), or(isNull(users.lockedUntil), lte(users.lockedUntil, now))))
    .returning({ id: users.id });
  return reserved.length > 0;
}

/**
 * Verifies identifier + password with lockout. Unknown, inactive, locked and
 * passwordless users are all `invalid_credentials`; `password_change_required`
 * is returned only after the password itself verified.
 */
export async function checkPasswordLogin(
  db: Db,
  identifier: string,
  password: string,
  opts: { maxFailures: number; lockMinutes: number; now?: Date }
): Promise<PasswordLoginResult> {
  const now = opts.now ?? new Date();
  const user = await findUserByIdentifier(db, identifier);
  if (!user?.isActive || !user.passwordHash) return equalizeTiming(password);
  if (!(await reserveAttempt(db, user.id, opts, now))) return equalizeTiming(password);

  // A wrong password stays counted by the reservation; the right one clears it.
  if (!(await verifyPassword(user.passwordHash, password))) return INVALID;

  await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
  if (user.mustChangePassword) return { ok: false, reason: "password_change_required" };
  return { ok: true, user };
}
