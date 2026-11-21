import { isGranted } from "@mono/auth";
import { AppError, MESSAGES } from "@mono/server-kit";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import { verifyOwnToken } from "../auth/verify-own-token.js";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { isPlatformPermission } from "../permissions.js";
import { findAdminActor } from "./guard.repository.js";

/** Who is calling `/api/admin/*`, from the verified admin-app access token. */
export type AdminContext = { userId: string; orgId: string; permissions: string[] };

declare module "fastify" {
  interface FastifyRequest {
    admin?: AdminContext;
  }
}

function bearerToken(request: FastifyRequest): string {
  const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "");
  if (!match?.[1]) throw new AppError(401, MESSAGES.invalidToken);
  return match[1];
}

/** Call once on the instance (or encapsulated scope) that holds the guarded routes. */
export function registerAdminGuard(app: FastifyInstance): void {
  if (!app.hasRequestDecorator("admin")) app.decorateRequest("admin", undefined);
}

/**
 * `onRequest` hook for admin routes (auth runs before validation): the bearer token must be this service's own access token
 * issued to `ADMIN_CLIENT_ID` (`aud` and `client_id`); every permission in `required` must
 * be among the token's `permissions` (`isGranted`). No/invalid token → 401, missing
 * permission → 403. Sets `request.admin`.
 *
 * Tokens outlive changes, so every request also re-checks the database: the user must exist
 * and be active (401); a route needing a `platform:*` permission needs `is_platform_admin` still
 * set (403); any other admin route needs an active membership in the token's org unless the
 * user is a platform admin (403).
 */
export function requireAdmin(
  { env, db }: { env: Env; db: Db },
  ...required: string[]
): onRequestAsyncHookHandler {
  const needsPlatform = required.some(isPlatformPermission);
  return async (request) => {
    const claims = await verifyOwnToken(env, bearerToken(request), {
      audience: env.ADMIN_CLIENT_ID,
    });
    if (claims.clientId !== env.ADMIN_CLIENT_ID) throw new AppError(401, MESSAGES.invalidToken);
    const granted = new Set(claims.permissions);
    if (!required.every((permission) => isGranted(granted, permission))) {
      throw new AppError(403, MESSAGES.forbidden);
    }
    const actor = await findAdminActor(db, claims.sub, claims.orgId);
    if (!actor?.isActive) throw new AppError(401, MESSAGES.invalidToken);
    if (needsPlatform ? !actor.isPlatformAdmin : !actor.isPlatformAdmin && !actor.memberActive) {
      throw new AppError(403, MESSAGES.forbidden);
    }
    request.admin = {
      userId: claims.sub,
      orgId: claims.orgId,
      permissions: claims.permissions,
    };
  };
}
