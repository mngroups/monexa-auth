import { AppError } from "@mono/server-kit";
import type { Db } from "../../db/client.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { type Actor, audit } from "../platform/common.js";
import { deleteMemberRoles } from "./members.repository.js";
import { memberView, requireMember } from "./members.service.js";
import * as repo from "./roles.repository.js";

/** Replaces the member's roles in this org; every role's app must be enabled for the org. */
export function setMemberRoles(
  db: Db,
  actor: Actor,
  orgId: string,
  userId: string,
  roleIds: string[]
) {
  const wanted = [...new Set(roleIds)];
  return db.transaction(async (tx) => {
    await requireMember(tx, orgId, userId);
    const found = await repo.rolesWithEnablement(tx, orgId, wanted);
    if (found.length !== wanted.length) throw new AppError(422, MESSAGES_AUTH.roleNotFound);
    if (found.some((r) => !r.enabled)) throw new AppError(422, MESSAGES_AUTH.roleAppNotEnabled);
    await deleteMemberRoles(tx, orgId, userId);
    await repo.insertMemberRoles(tx, orgId, userId, wanted);
    await audit(tx, actor, {
      orgId,
      action: "admin.member.roles_set",
      targetType: "user",
      targetId: userId,
      metadata: { roleIds: wanted },
    });
    return memberView(tx, orgId, userId);
  });
}
