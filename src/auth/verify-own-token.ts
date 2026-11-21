import { createPublicKey } from "node:crypto";
import { AppError, MESSAGES } from "@mono/server-kit";
import { jwtVerify } from "jose";
import type { Env } from "../env.js";

export type OwnTokenClaims = {
  sub: string;
  clientId: string;
  orgId: string;
  /** The token's `permissions` claim (empty when absent). */
  permissions: string[];
};

/**
 * Verifies an access token this service issued, with the public half of its own signing
 * key (no JWKS fetch): RS256, `iss` and `exp` checked, any audience (each app is its own)
 * unless `audience` pins one.
 */
export async function verifyOwnToken(
  env: Env,
  token: string,
  opts: { audience?: string } = {}
): Promise<OwnTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, createPublicKey(env.OIDC_SIGNING_KEY), {
      algorithms: ["RS256"],
      issuer: `${env.OIDC_ISSUER}/oidc`,
      audience: opts.audience,
    });
    const { sub, client_id: clientId, org_id: orgId, permissions } = payload;
    if (typeof sub !== "string" || typeof clientId !== "string" || typeof orgId !== "string") {
      throw new Error("missing claims");
    }
    return {
      sub,
      clientId,
      orgId,
      permissions: Array.isArray(permissions)
        ? permissions.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    throw new AppError(401, MESSAGES.invalidToken);
  }
}
