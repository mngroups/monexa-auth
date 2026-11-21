import { AppError } from "@mono/server-kit";
import type { Db } from "../../db/client.js";
import type { UserRow } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { revokeGrants } from "../../oidc/revoke.js";
import { newPasswordError } from "../../users/password-policy.js";
import { hashPassword } from "../../users/passwords.js";
import { type Actor, audit, iso, orConflict, type PageQuery } from "./common.js";
import * as repo from "./platform-admins.repository.js";

/** The user as the API shows it: never the password hash. */
export const toUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  username: u.username,
  name: u.name,
  isActive: u.isActive,
  isPlatformAdmin: u.isPlatformAdmin,
  mustChangePassword: u.mustChangePassword,
  createdAt: iso(u.createdAt),
});

export async function listUsers(db: Db, q: PageQuery & { q?: string }) {
  const { items, total } = await repo.listUsers(db, q);
  return { items: items.map(toUser), page: q.page, pageSize: q.pageSize, total };
}

/** The password is temporary: the user must change it at first sign-in. */
export async function createUser(
  db: Db,
  actor: Actor,
  input: { email: string; username?: string; name: string; temporaryPassword: string }
) {
  const problem = newPasswordError(input.temporaryPassword, input.temporaryPassword);
  if (problem) throw new AppError(422, problem);
  const passwordHash = await hashPassword(input.temporaryPassword);
  return orConflict(MESSAGES_AUTH.emailTaken, () =>
    db.transaction(async (tx) => {
      const user = await repo.insertUser(tx, {
        email: input.email,
        username: input.username,
        name: input.name,
        passwordHash,
      });
      await audit(tx, actor, {
        action: "admin.user.created",
        targetType: "user",
        targetId: user.id,
        metadata: { email: user.email, username: user.username },
      });
      return toUser(user);
    })
  );
}

export function grantPlatformAdmin(db: Db, actor: Actor, userId: string) {
  return db.transaction(async (tx) => {
    const user = await repo.setPlatformAdmin(tx, userId, true);
    if (!user) throw new AppError(404, MESSAGES_AUTH.userNotFound);
    await audit(tx, actor, {
      action: "admin.user.platform_admin_granted",
      targetType: "user",
      targetId: userId,
    });
    return toUser(user);
  });
}

/** Revoking also ends the user's admin-app grants, so the token's `platform:all` stops at once. */
export function revokePlatformAdmin(db: Db, env: Env, actor: Actor, userId: string) {
  if (actor.userId === userId) throw new AppError(422, MESSAGES_AUTH.selfRevokeNotAllowed);
  return db.transaction(async (tx) => {
    const user = await repo.setPlatformAdmin(tx, userId, false);
    if (!user) throw new AppError(404, MESSAGES_AUTH.userNotFound);
    const adminAppId = await repo.findAppIdByClientId(tx, env.ADMIN_CLIENT_ID);
    if (adminAppId) await revokeGrants(tx, { userId, appId: adminAppId });
    await audit(tx, actor, {
      action: "admin.user.platform_admin_revoked",
      targetType: "user",
      targetId: userId,
    });
    return toUser(user);
  });
}
