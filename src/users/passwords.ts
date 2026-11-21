import { hash, verify } from "@node-rs/argon2";
import { eq, sql } from "drizzle-orm";
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
  const lockExpired = user.lockedUntil !== null && user.lockedUntil <= now;
  if (user.lockedUntil && !lockExpired) return equalizeTiming(password);

  if (!(await verifyPassword(user.passwordHash, password))) {
    const lockUntil = new Date(now.getTime() + opts.lockMinutes * 60_000).toISOString();
    // An expired lock starts a fresh failure window: this failure counts as the first.
    const base = lockExpired ? sql`0` : sql`${users.failedLogins}`;
    const keepLock = lockExpired ? sql`null` : sql`${users.lockedUntil}`;
    await db
      .update(users)
      .set({
        failedLogins: sql`${base} + 1`,
        lockedUntil: sql`case when ${base} + 1 >= ${opts.maxFailures} then ${lockUntil}::timestamptz else ${keepLock} end`,
      })
      .where(eq(users.id, user.id));
    return INVALID;
  }

  await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
  if (user.mustChangePassword) return { ok: false, reason: "password_change_required" };
  return { ok: true, user };
}
