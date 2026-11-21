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
  if (!user?.isActive || !user.passwordHash) return INVALID;
  if (user.lockedUntil && user.lockedUntil > now) return INVALID;

  if (!(await verifyPassword(user.passwordHash, password))) {
    const lockUntil = new Date(now.getTime() + opts.lockMinutes * 60_000).toISOString();
    await db
      .update(users)
      .set({
        failedLogins: sql`${users.failedLogins} + 1`,
        lockedUntil: sql`case when ${users.failedLogins} + 1 >= ${opts.maxFailures} then ${lockUntil}::timestamptz else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, user.id));
    return INVALID;
  }

  await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
  if (user.mustChangePassword) return { ok: false, reason: "password_change_required" };
  return { ok: true, user };
}
