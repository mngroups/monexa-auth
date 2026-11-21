import { MESSAGES } from "@mono/server-kit";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity/log.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema/index.js";
import type { Env } from "../env.js";
import { findUserByIdentifier } from "../users/lookup.js";
import { newPasswordError } from "../users/password-policy.js";
import { checkPasswordLogin, hashPassword } from "../users/passwords.js";

export type PasswordForm = {
  identifier?: string;
  current_password?: string;
  new_password?: string;
  confirm_password?: string;
};

export type PasswordResult = { ok: true } | { ok: false; status: 400 | 401; error: string };

/**
 * Replaces a password without any app session. The current password goes through the same
 * check as a login (lockout included); `password_change_required` counts as verified.
 * Unknown, inactive, locked and wrong-password users all get the same answer.
 */
export async function changePassword(
  deps: { db: Db; env: Env },
  form: PasswordForm,
  audit: { ip?: string; userAgent?: string }
): Promise<PasswordResult> {
  const { db, env } = deps;
  const next = form.new_password ?? "";
  const policyError = newPasswordError(next, form.confirm_password);
  if (policyError) return { ok: false, status: 400, error: policyError };

  const identifier = form.identifier ?? "";
  const check = await checkPasswordLogin(db, identifier, form.current_password ?? "", {
    maxFailures: env.LOCKOUT_MAX_FAILURES,
    lockMinutes: env.LOCKOUT_MINUTES,
  });
  const verified = check.ok || check.reason === "password_change_required";
  const user = verified ? await findUserByIdentifier(db, identifier) : null;
  if (!user) {
    const known = await findUserByIdentifier(db, identifier);
    // Only known users are logged, and never by what was typed in the identifier field.
    if (known) {
      await logActivity(db, {
        actorUserId: known.id,
        orgId: null,
        action: "auth.login.failed",
        targetType: "user",
        targetId: known.id,
        ...audit,
        metadata: { reason: "invalid_credentials", via: "account_password" },
      });
    }
    return { ok: false, status: 401, error: MESSAGES.invalidCredentials };
  }

  const passwordHash = await hashPassword(next);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logActivity(tx, {
      actorUserId: user.id,
      orgId: null,
      action: "auth.password.changed",
      targetType: "user",
      targetId: user.id,
      ...audit,
      metadata: { via: "account_password" },
    });
  });
  return { ok: true };
}
