import { AppError } from "@mono/server-kit";
import type { Db } from "../../db/client.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { findApp } from "./apps.repository.js";
import { type Actor, audit, iso } from "./common.js";
import { inCatalog } from "./permissions.repository.js";
import { isPlatformPermission } from "./permissions.service.js";
import * as repo from "./roles.repository.js";

const toRole = (r: repo.RoleWithPermissions) => ({
  id: r.id,
  appId: r.appId,
  name: r.name,
  description: r.description,
  permissions: r.permissions,
  createdAt: iso(r.createdAt),
});

async function requireApp(db: Db, appId: string) {
  if (!(await findApp(db, appId))) throw new AppError(404, MESSAGES_AUTH.appNotFound);
}

async function requireRole(db: Db, appId: string, roleId: string) {
  await requireApp(db, appId);
  const role = await repo.findRole(db, appId, roleId);
  if (!role) throw new AppError(404, MESSAGES_AUTH.roleNotFound);
  return role;
}

/** Roles never carry `platform:*`, and every permission must be in the app's catalog (422). */
async function checkPermissions(db: Db, appId: string, permissions: string[]) {
  if (permissions.some(isPlatformPermission)) {
    throw new AppError(422, MESSAGES_AUTH.platformPermissionReserved);
  }
  const known = await inCatalog(db, appId, permissions);
  if (permissions.some((p) => !known.has(p))) {
    throw new AppError(422, MESSAGES_AUTH.permissionsNotInCatalog);
  }
}

async function checkName(db: Db, appId: string, name: string, exceptId?: string) {
  if (await repo.roleNameTaken(db, appId, name, exceptId)) {
    throw new AppError(409, MESSAGES_AUTH.roleNameTaken);
  }
}

export async function listRoles(db: Db, appId: string) {
  await requireApp(db, appId);
  return (await repo.listRoles(db, appId)).map(toRole);
}

export function createRole(
  db: Db,
  actor: Actor,
  appId: string,
  input: { name: string; description: string; permissions: string[] }
) {
  const permissions = [...new Set(input.permissions)];
  return db.transaction(async (tx) => {
    await requireApp(tx, appId);
    await checkPermissions(tx, appId, permissions);
    await checkName(tx, appId, input.name);
    const role = await repo.insertRole(tx, {
      appId,
      name: input.name,
      description: input.description,
    });
    await repo.setRolePermissions(tx, role.id, permissions);
    await audit(tx, actor, {
      action: "admin.role.created",
      targetType: "role",
      targetId: role.id,
      metadata: { appId, name: role.name, permissions },
    });
    return toRole({ ...role, permissions: permissions.sort() });
  });
}

export function updateRole(
  db: Db,
  actor: Actor,
  appId: string,
  roleId: string,
  input: Partial<{ name: string; description: string }>
) {
  return db.transaction(async (tx) => {
    await requireRole(tx, appId, roleId);
    if (input.name !== undefined) await checkName(tx, appId, input.name, roleId);
    await repo.updateRole(tx, roleId, input);
    await audit(tx, actor, {
      action: "admin.role.updated",
      targetType: "role",
      targetId: roleId,
      metadata: { appId, fields: Object.keys(input) },
    });
    return toRole(await requireRole(tx, appId, roleId));
  });
}

export function setRolePermissions(
  db: Db,
  actor: Actor,
  appId: string,
  roleId: string,
  input: string[]
) {
  const permissions = [...new Set(input)];
  return db.transaction(async (tx) => {
    await requireRole(tx, appId, roleId);
    await checkPermissions(tx, appId, permissions);
    await repo.setRolePermissions(tx, roleId, permissions);
    await audit(tx, actor, {
      action: "admin.role.permissions_set",
      targetType: "role",
      targetId: roleId,
      metadata: { appId, permissions },
    });
    return toRole(await requireRole(tx, appId, roleId));
  });
}

export function deleteRole(db: Db, actor: Actor, appId: string, roleId: string) {
  return db.transaction(async (tx) => {
    const role = await requireRole(tx, appId, roleId);
    await repo.deleteRole(tx, roleId);
    await audit(tx, actor, {
      action: "admin.role.deleted",
      targetType: "role",
      targetId: roleId,
      metadata: { appId, name: role.name },
    });
    return { id: roleId };
  });
}
