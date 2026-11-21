import { createHash, createPrivateKey } from "node:crypto";
import { type Client, errors, type Grant, type JWK, type ResourceServer } from "oidc-provider";
import { resolveAccess } from "../access/permissions.js";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";

/** Reasons a grant is refused, sent as `error_description` with `invalid_grant`. */
export type GrantRefusal =
  | "invalid_credentials"
  | "no_app_access"
  | "password_change_required"
  | "org_not_eligible";

export function grantRefused(reason: GrantRefusal): errors.CustomOIDCProviderError {
  return new errors.CustomOIDCProviderError("invalid_grant", reason);
}

/** The `apps` properties the Client adapter adds to the client metadata. */
export type AppClient = Client & {
  app_id: string;
  access_ttl_seconds: number;
  refresh_ttl_seconds: number;
};

export const appClient = (client: Client) => client as AppClient;

const GRANT_MIN_TTL_SECONDS = 14 * 24 * 60 * 60;

/** A Grant outlives any refresh token of its app; refresh rotation slides within it. */
export function grantTtl(client: Client): number {
  return Math.max(GRANT_MIN_TTL_SECONDS, appClient(client).refresh_ttl_seconds);
}

/** A Grant also carries the org it was issued for (persisted in its payload). */
export type OrgGrant = Grant & { orgId: string };

/** The single signing key as a JWK, `kid` = its RFC 7638 thumbprint. */
export function signingJwk(pem: string): JWK {
  const jwk = createPrivateKey(pem).export({ format: "jwk" }) as JWK & { e: string; n: string };
  const thumbprint = createHash("sha256")
    .update(JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n }))
    .digest("base64url");
  return { ...jwk, kid: thumbprint, alg: "RS256", use: "sig" };
}

/** Access for the grant's org, recomputed now, so tokens never carry stale permissions. */
export async function grantAccess(
  db: Db,
  env: Env,
  client: Client,
  userId: string,
  grant: OrgGrant
) {
  const access = await resolveAccess(db, {
    userId,
    appId: appClient(client).app_id,
    orgId: grant.orgId,
    adminClientId: env.ADMIN_CLIENT_ID,
  });
  if (!access.ok) throw grantRefused(access.reason);
  return access;
}

/**
 * The resource indicator of an app's (only) resource server. oidc-provider requires an
 * absolute URI, so it wraps the client id; the token `aud` stays the bare client id.
 */
export function resourceIndicator(client: Client): string {
  return `urn:monexa:client:${client.clientId}`;
}

/** Every app is its own (only) resource server: JWT access tokens with `aud` = its client id. */
export function resourceServerInfo(client: Client): ResourceServer {
  return {
    scope: "",
    audience: client.clientId,
    accessTokenFormat: "jwt",
    accessTokenTTL: appClient(client).access_ttl_seconds,
    jwt: { sign: { alg: "RS256" } },
  };
}
