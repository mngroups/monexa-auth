import { AppError } from "@mono/server-kit";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type ActivityEvent, logActivity } from "../../activity/log.js";
import type { Db } from "../../db/client.js";

export const PLATFORM_PREFIX = "/api/admin/platform";

/** Shared route metadata: documented as bearer-protected. */
export const routeMeta = { tags: ["admin-platform"], security: [{ bearerAuth: [] }] };

export const idParams = z.object({ id: z.uuid() });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuery>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

export const isoDate = z.iso.datetime();
export const iso = (d: Date): string => d.toISOString();

/**
 * The caller of a mutation, as the audit row needs it. `isPlatformAdmin` (live, from the guard)
 * lifts the org-admin-only protections; self-action refusals apply to everyone.
 */
export type Actor = { userId: string; isPlatformAdmin?: boolean; ip?: string; userAgent?: string };

export function actorOf(request: FastifyRequest): Actor {
  const admin = request.admin;
  if (!admin) throw new AppError(401, "unauthenticated");
  return {
    userId: admin.userId,
    isPlatformAdmin: admin.isPlatformAdmin,
    ip: request.ip,
    userAgent: request.headers["user-agent"],
  };
}

/** Writes the one `activity_log` row of an admin mutation; call it inside the mutation's transaction. */
export function audit(
  tx: Db,
  actor: Actor,
  e: Pick<ActivityEvent, "action" | "targetType" | "targetId" | "metadata"> & {
    orgId?: string | null;
  }
): Promise<void> {
  return logActivity(tx, {
    actorUserId: actor.userId,
    orgId: e.orgId ?? null,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    ip: actor.ip,
    userAgent: actor.userAgent,
    metadata: e.metadata,
  });
}

/** Escapes `%`, `_` and `\` so user input matches literally inside `ILIKE`. */
export const containsPattern = (q: string): string => `%${q.replace(/[\\%_]/g, "\\$&")}%`;

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 3; depth++) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Runs `fn`; a unique-constraint violation becomes a 409 with `message`. */
export async function orConflict<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, message);
    throw error;
  }
}

export const paging = ({ page, pageSize }: PageQuery) => ({
  limit: pageSize,
  offset: (page - 1) * pageSize,
});
