import { AppError } from "@mono/server-kit";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

export { actorOf, idParams, isoDate, pageOf, pageQuery } from "../platform/common.js";

export const ORG_PREFIX = "/api/admin/org";

/** Shared route metadata: documented as bearer-protected. */
export const routeMeta = { tags: ["admin-org"], security: [{ bearerAuth: [] }] };

export const userIdParams = z.object({ userId: z.uuid() });

/** The org every org-admin action is scoped to: the token's `org_id`, never request input. */
export function orgOf(request: FastifyRequest): string {
  const admin = request.admin;
  if (!admin) throw new AppError(401, "unauthenticated");
  return admin.orgId;
}
