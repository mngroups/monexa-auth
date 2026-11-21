import { AppError } from "@mono/server-kit";
import type { Db } from "../../db/client.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { revokeGrants } from "../../oidc/revoke.js";
import { newPasswordError } from "../../users/password-policy.js";
import { hashPassword } from "../../users/passwords.js";
import { type Actor, audit, orConflict, type PageQuery } from "../platform/common.js";
import { insertUser } from "../platform/platform-admins.repository.js";
import * as repo from "./members.repository.js";

type Member = repo.MemberRow & { roles: { id: string; name: string; appId: string }[] };

const withRoles = async (db: Db, orgId: string, members: repo.MemberRow[]): Promise<Member[]> => {
  const roles = await repo.rolesOfMembers(
    db,
    orgId,
    members.map((m) => m.userId)
  );
  return members.map((m) => ({ ...m, roles: roles.get(m.userId) ?? [] }));
};

/** A member of this org, or 404: a user of another org is indistinguishable from a missing one. */
export async function requireMember(db: Db, orgId: string, userId: string) {
  const member = await repo.findMember(db, orgId, userId);
  if (!member) throw new AppError(404, MESSAGES_AUTH.userNotFound);
  return member;
}

/**
 * For changes that cut access or alter privileges: an admin never targets themselves (no
 * self-escalation, no self-lockout) and an org admin never touches a platform admin.
 */
export async function requireManageable(db: Db, actor: Actor, orgId: string, userId: string) {
  await requireMember(db, orgId, userId);
  if (actor.userId === userId) throw new AppError(422, MESSAGES_AUTH.selfActionNotAllowed);
  const user = await repo.findUser(db, userId);
  if (user?.isPlatformAdmin) throw new AppError(403, MESSAGES_AUTH.platformAdminProtected);
}

/** Member as the API shows it after a change, re-read inside the transaction. */
export async function memberView(db: Db, orgId: string, userId: string): Promise<Member> {
  const [member] = await withRoles(db, orgId, [await requireMember(db, orgId, userId)]);
  return member as Member;
}

export async function listMembers(db: Db, orgId: string, q: PageQuery & { q?: string }) {
  const { items, total } = await repo.listMembers(db, orgId, q);
  return { items: await withRoles(db, orgId, items), page: q.page, pageSize: q.pageSize, total };
}

/** The password is temporary: the user must change it at first sign-in. */
export async function createMember(
  db: Db,
  actor: Actor,
  orgId: string,
  input: { email: string; username?: string; name: string; temporaryPassword: string }
) {
  const problem = newPasswordError(input.temporaryPassword, input.temporaryPassword);
  if (problem) throw new AppError(422, problem);
  const passwordHash = await hashPassword(input.temporaryPassword);
  return orConflict(MESSAGES_AUTH.emailTaken, () =>
    db.transaction(async (tx) => {
      const user = await insertUser(tx, {
        email: input.email,
        username: input.username,
        name: input.name,
        passwordHash,
      });
      await repo.insertMembership(tx, orgId, user.id);
      await audit(tx, actor, {
        orgId,
        action: "admin.member.created",
        targetType: "user",
        targetId: user.id,
        metadata: { email: user.email, username: user.username },
      });
      return memberView(tx, orgId, user.id);
    })
  );
}

export function addExistingMember(db: Db, actor: Actor, orgId: string, email: string) {
  return orConflict(MESSAGES_AUTH.memberExists, () =>
    db.transaction(async (tx) => {
      const user = await repo.findUserByEmail(tx, email);
      if (!user) throw new AppError(404, MESSAGES_AUTH.userNotFound);
      await repo.insertMembership(tx, orgId, user.id);
      await audit(tx, actor, {
        orgId,
        action: "admin.member.added",
        targetType: "user",
        targetId: user.id,
        metadata: { email: user.email },
      });
      return memberView(tx, orgId, user.id);
    })
  );
}

export function removeMember(db: Db, actor: Actor, orgId: string, userId: string) {
  return db.transaction(async (tx) => {
    await requireManageable(tx, actor, orgId, userId);
    await repo.deleteMemberRoles(tx, orgId, userId);
    await repo.deleteMembership(tx, orgId, userId);
    await revokeGrants(tx, { userId, orgId });
    await audit(tx, actor, {
      orgId,
      action: "admin.member.removed",
      targetType: "user",
      targetId: userId,
    });
    return { userId };
  });
}

export function setMemberActive(
  db: Db,
  actor: Actor,
  orgId: string,
  userId: string,
  isActive: boolean
) {
  return db.transaction(async (tx) => {
    if (isActive) await requireMember(tx, orgId, userId);
    else await requireManageable(tx, actor, orgId, userId);
    await repo.setMembershipActive(tx, orgId, userId, isActive);
    if (!isActive) await revokeGrants(tx, { userId, orgId });
    await audit(tx, actor, {
      orgId,
      action: isActive ? "admin.member.activated" : "admin.member.deactivated",
      targetType: "user",
      targetId: userId,
    });
    return memberView(tx, orgId, userId);
  });
}

/**
 * Only when the org is the user's whole footprint: a user who is also in another org, or who is a
 * platform admin, can be reset only by a platform admin. Ends every grant and session of the user.
 */
export async function resetMemberPassword(
  db: Db,
  actor: Actor,
  orgId: string,
  userId: string,
  temporaryPassword: string
) {
  const problem = newPasswordError(temporaryPassword, temporaryPassword);
  if (problem) throw new AppError(422, problem);
  const passwordHash = await hashPassword(temporaryPassword);
  return db.transaction(async (tx) => {
    await requireMember(tx, orgId, userId);
    const user = await repo.findUser(tx, userId);
    if (!user || user.isPlatformAdmin || (await repo.belongsToOtherOrg(tx, orgId, userId))) {
      throw new AppError(403, MESSAGES_AUTH.resetNotAllowed);
    }
    await repo.resetPassword(tx, userId, passwordHash);
    await revokeGrants(tx, { userId });
    await audit(tx, actor, {
      orgId,
      action: "admin.member.password_reset",
      targetType: "user",
      targetId: userId,
    });
    return memberView(tx, orgId, userId);
  });
}
