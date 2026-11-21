import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { registerAdminGuard } from "../guard.js";
import { activityRoutes } from "./activity.routes.js";
import { brandingRoutes } from "./branding.routes.js";
import { memberRoutes } from "./members.routes.js";
import { memberRoleRoutes } from "./roles.routes.js";

/**
 * `/api/admin/org/*`: org admins manage their own org only. Each route group guards its own
 * permission; every action is scoped to the token's `org_id` (`request.admin.orgId`).
 */
export async function orgAdminRoutes(app: FastifyInstance, deps: { db: Db; env: Env }) {
  registerAdminGuard(app);
  await app.register(memberRoutes, deps);
  await app.register(memberRoleRoutes, deps);
  await app.register(activityRoutes, deps);
  await app.register(brandingRoutes, deps);
}
