import { AppError } from "@mono/server-kit";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { isPlatformPermission } from "../../permissions.js";
import { findApp } from "./apps.repository.js";
import { type Actor, audit, orConflict } from "./common.js";
import * as repo from "./permissions.repository.js";

export { isPlatformPermission };

async function requireApp(db: Db, appId: string) {
  const app = await findApp(db, appId);
  if (!app) throw new AppError(404, MESSAGES_AUTH.appNotFound);
  return app;
}

export async function listPermissions(db: Db, appId: string) {
  await requireApp(db, appId);
  return repo.listPermissions(db, appId);
}

/** `platform:*` belongs only to the admin app's catalog. */
export function addPermission(
  db: Db,
  env: Env,
  actor: Actor,
  appId: string,
  input: { permission: string; description: string }
) {
  return orConflict(MESSAGES_AUTH.permissionTaken, () =>
    db.transaction(async (tx) => {
      const app = await requireApp(tx, appId);
      if (isPlatformPermission(input.permission) && app.clientId !== env.ADMIN_CLIENT_ID) {
        throw new AppError(422, MESSAGES_AUTH.platformPermissionReserved);
      }
      const row = await repo.insertPermission(tx, { appId, ...input });
      await audit(tx, actor, {
        action: "admin.app_permission.added",
        targetType: "app_permission",
        targetId: `${appId}:${input.permission}`,
        metadata: { appId, permission: input.permission },
      });
      return row;
    })
  );
}

export function removePermission(db: Db, actor: Actor, appId: string, permission: string) {
  return db.transaction(async (tx) => {
    await requireApp(tx, appId);
    if (!(await repo.deletePermission(tx, appId, permission))) {
      throw new AppError(404, MESSAGES_AUTH.permissionNotFound);
    }
    await audit(tx, actor, {
      action: "admin.app_permission.removed",
      targetType: "app_permission",
      targetId: `${appId}:${permission}`,
      metadata: { appId, permission },
    });
    return { permission };
  });
}
