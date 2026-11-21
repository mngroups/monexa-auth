import { eq } from "drizzle-orm";
import Provider, { type Client, type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import type { Db } from "../db/client.js";
import { users } from "../db/schema/index.js";
import type { Env } from "../env.js";
import { createAdapter } from "./adapter.js";
import {
  appClient,
  grantAccess,
  grantRefused,
  type OrgGrant,
  resourceServerInfo,
  signingJwk,
} from "./grant-access.js";
import { PASSWORD_GRANT_PARAMS, passwordGrantHandler } from "./grants/password.js";
import { addRefreshExpiresIn } from "./token-response.js";

const GRANT_MIN_TTL_SECONDS = 14 * 24 * 60 * 60;

export function createProvider({ env, db }: { env: Env; db: Db }): Provider {
  const adapter = createAdapter(db, {
    clientSecretKey: Buffer.from(env.CLIENT_SECRET_KEY, "base64"),
  });

  const configuration: Configuration = {
    adapter,
    jwks: { keys: [signingJwk(env.OIDC_SIGNING_KEY)] },
    cookies: { keys: env.OIDC_COOKIE_KEYS },
    extraClientMetadata: { properties: ["app_id", "access_ttl_seconds", "refresh_ttl_seconds"] },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      rpInitiatedLogout: { enabled: true },
      resourceIndicators: {
        enabled: true,
        // Every app is its own (only) resource server: `aud` is the client id.
        defaultResource: (_ctx, client) => client.clientId,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, _resource, client) => resourceServerInfo(client),
      },
    },
    pkce: { required: () => true },
    rotateRefreshToken: true,
    ttl: {
      AccessToken: (_ctx, _token, client) => appClient(client).access_ttl_seconds,
      RefreshToken: (_ctx, _token, client) => appClient(client).refresh_ttl_seconds,
      // Outlives any refresh token of its app; refresh rotation slides within it.
      Grant: (ctx) =>
        Math.max(GRANT_MIN_TTL_SECONDS, appClient(ctx.oidc.client as Client).refresh_ttl_seconds),
    },
    /**
     * Called at the token endpoint with the refresh token, after the grant is loaded and
     * before anything is issued: a deactivated user or lost access ends the session here.
     */
    findAccount: async (ctx: KoaContextWithOIDC, sub: string) => {
      const [user] = await db
        .select({ isActive: users.isActive })
        .from(users)
        .where(eq(users.id, sub));
      if (!user?.isActive) throw grantRefused("invalid_credentials");
      const grant = ctx.oidc.entities.Grant as OrgGrant | undefined;
      if (grant) await grantAccess(db, env, ctx.oidc.client as Client, sub, grant);
      return { accountId: sub, claims: () => ({ sub }) };
    },
    extraTokenClaims: async (ctx, token) => {
      const { client, entities } = ctx.oidc;
      const accountId = (token as { accountId: string }).accountId;
      const access = await grantAccess(
        db,
        env,
        client as Client,
        accountId,
        entities.Grant as OrgGrant
      );
      return {
        azp: (client as Client).clientId,
        org_id: access.org.id,
        org_name: access.org.name,
        permissions: access.permissions,
      };
    },
  };

  const provider = new Provider(`${env.OIDC_ISSUER}/oidc`, configuration);
  provider.proxy = env.TRUST_PROXY;

  // Persist `orgId` in the Grant payload (the model only keeps its known properties).
  const grantPayload = provider.Grant as unknown as { IN_PAYLOAD: string[] };
  const inPayload = [...grantPayload.IN_PAYLOAD, "orgId"];
  Object.defineProperty(provider.Grant, "IN_PAYLOAD", { get: () => inPayload });

  provider.registerGrantType("password", passwordGrantHandler({ db, env }), PASSWORD_GRANT_PARAMS);
  provider.use(addRefreshExpiresIn);
  return provider;
}
