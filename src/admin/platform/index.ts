import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { PERMISSIONS } from "../../permissions.js";
import { registerAdminGuard, requireAdmin } from "../guard.js";
import { activityRoutes } from "./activity.routes.js";
import { appRoutes } from "./apps.routes.js";
import { orgRoutes } from "./orgs.routes.js";
import { permissionRoutes } from "./permissions.routes.js";
import { platformAdminRoutes } from "./platform-admins.routes.js";
import { roleRoutes } from "./roles.routes.js";

/** `/api/admin/platform/*`: every route needs `platform:all` on a `monexa-admin` token. */
export async function platformRoutes(app: FastifyInstance, deps: { db: Db; env: Env }) {
  registerAdminGuard(app);
  app.addHook("onRequest", requireAdmin(deps, PERMISSIONS.platformAll));
  await app.register(orgRoutes, deps);
  await app.register(appRoutes, deps);
  await app.register(permissionRoutes, deps);
  await app.register(roleRoutes, deps);
  await app.register(platformAdminRoutes, deps);
  await app.register(activityRoutes, deps);
}
