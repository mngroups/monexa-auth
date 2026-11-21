import { createPublicKey } from "node:crypto";
import { AppError, MESSAGES } from "@mono/server-kit";
import { jwtVerify } from "jose";
import type { Env } from "../env.js";

export type OwnTokenClaims = { sub: string; clientId: string; orgId: string };

/**
 * Verifies an access token this service issued, with the public half of its own signing
 * key (no JWKS fetch): RS256, `iss` and `exp` checked, any audience (each app is its own).
 */
export async function verifyOwnToken(env: Env, token: string): Promise<OwnTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, createPublicKey(env.OIDC_SIGNING_KEY), {
      algorithms: ["RS256"],
      issuer: `${env.OIDC_ISSUER}/oidc`,
    });
    const { sub, client_id: clientId, org_id: orgId } = payload;
    if (typeof sub !== "string" || typeof clientId !== "string" || typeof orgId !== "string") {
      throw new Error("missing claims");
    }
    return { sub, clientId, orgId };
  } catch {
    throw new AppError(401, MESSAGES.invalidToken);
  }
}
