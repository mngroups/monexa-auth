import { MESSAGES } from "@mono/server-kit";
import { eq } from "drizzle-orm";
import Provider, { type Client, type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import { hintNamesOrg } from "../access/org-hint.js";
import { resolveAccess } from "../access/permissions.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema/index.js";
import type { Env } from "../env.js";
import { createAdapter } from "./adapter.js";
import {
  appClient,
  grantAccess,
  grantRefused,
  grantTtl,
  type OrgGrant,
  resourceIndicator,
  resourceServerInfo,
  signingJwk,
} from "./grant-access.js";
import { ORG_SWITCH_GRANT, ORG_SWITCH_PARAMS, orgSwitchGrantHandler } from "./grants/org-switch.js";
import { PASSWORD_GRANT_PARAMS, passwordGrantHandler } from "./grants/password.js";
import { allowPostLogoutRedirect } from "./interactions/csp.js";
import { renderView } from "./interactions/render.js";
import { INTERACTION_PREFIX } from "./interactions/routes.js";
import { addRefreshExpiresIn } from "./token-response.js";

const AUTHORIZE_ROUTES = new Set(["authorization", "resume"]);

function html(ctx: KoaContextWithOIDC, body: string) {
  ctx.type = "html";
  ctx.body = body;
}

export function createProvider({ env, db }: { env: Env; db: Db }): Provider {
  const adapter = createAdapter(db, {
    clientSecretKey: Buffer.from(env.CLIENT_SECRET_KEY, "base64"),
  });

  async function stillAllowed(client: Client, grant: OrgGrant): Promise<boolean> {
    const accountId = grant.accountId as string;
    const [user] = await db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, accountId));
    if (!user?.isActive) return false;
    const access = await resolveAccess(db, {
      userId: accountId,
      appId: appClient(client).app_id,
      orgId: grant.orgId,
      adminClientId: env.ADMIN_CLIENT_ID,
    });
    return access.ok;
  }

  const configuration: Configuration = {
    adapter,
    jwks: { keys: [signingJwk(env.OIDC_SIGNING_KEY)] },
    cookies: { keys: env.OIDC_COOKIE_KEYS },
    extraClientMetadata: { properties: ["app_id", "access_ttl_seconds", "refresh_ttl_seconds"] },
    // An app may name the org to sign in to; the interaction uses it when it is eligible.
    extraParams: ["org_hint"],
    interactions: { url: (_ctx, interaction) => `${INTERACTION_PREFIX}/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        // First-party apps only: the logout page submits itself, no confirmation.
        logoutSource: (ctx, form) => {
          // Our refresh tokens are not session-bound (`expiresWithSession` false), which the
          // provider records as `persistsLogout` and then skips at logout. A Monexa logout
          // ends every app's grant in the session, so clear it before the confirm POST.
          const { session } = ctx.oidc;
          for (const clientId of Object.keys(session?.authorizations ?? {})) {
            const authorization = session?.authorizationFor(clientId);
            if (authorization) authorization.persistsLogout = false;
          }
          html(ctx, renderView("logout", { form }));
        },
        postLogoutSuccessSource: (ctx) => html(ctx, renderView("logged-out")),
      },
      resourceIndicators: {
        enabled: true,
        // Every app is its own (only) resource server: `aud` is the client id
        // (indicator `urn:monexa:client:<client_id>`, audience the bare client id).
        defaultResource: (_ctx, client) => resourceIndicator(client),
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, _resource, client) => resourceServerInfo(client),
      },
    },
    pkce: { required: () => true },
    rotateRefreshToken: true,
    // The code flow issues refresh tokens like the password grant, living for the app's
    // refresh TTL rather than the browser session (logout revokes the session's grants).
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    expiresWithSession: () => false,
    /**
     * A grant remembered in the session is reused (SSO without any page) only while it still
     * fits: same org as an `org_hint`, user active, access to its org intact. Otherwise the
     * interaction runs again and picks the org; a grant it just created is always used.
     */
    loadExistingGrant: async (ctx) => {
      const { oidc } = ctx;
      const client = oidc.client as Client;
      const fresh = oidc.result?.consent?.grantId;
      const grantId = fresh ?? oidc.session?.grantIdFor(client.clientId);
      if (!grantId) return undefined;
      const grant = (await oidc.provider.Grant.find(grantId)) as OrgGrant | undefined;
      if (!grant?.orgId) return undefined;
      if (fresh) return grant;
      const hint = oidc.params?.org_hint;
      if (hint && !(await hintNamesOrg(db, grant.orgId, hint))) return undefined;
      return (await stillAllowed(client, grant)) ? grant : undefined;
    },
    renderError: (ctx, out) =>
      html(
        ctx,
        renderView("error", {
          message: MESSAGES.badRequest,
          code: out.error,
          description: out.error_description,
        })
      ),
    ttl: {
      AccessToken: (_ctx, _token, client) => appClient(client).access_ttl_seconds,
      RefreshToken: (_ctx, _token, client) => appClient(client).refresh_ttl_seconds,
      Grant: (ctx) => grantTtl(ctx.oidc.client as Client),
    },
    /**
     * Called at the token endpoint (code, refresh token) after the grant is loaded and
     * before anything is issued: a deactivated user or lost access ends the session here.
     */
    findAccount: async (ctx: KoaContextWithOIDC, sub: string) => {
      const account = { accountId: sub, claims: () => ({ sub }) };
      // At authorize the session's account is only loaded: `loadExistingGrant` and the
      // interaction decide whether it may continue (an inactive user gets the login form).
      if (AUTHORIZE_ROUTES.has(ctx.oidc.route)) return account;
      const [user] = await db
        .select({ isActive: users.isActive })
        .from(users)
        .where(eq(users.id, sub));
      if (!user?.isActive) throw grantRefused("invalid_credentials");
      const grant = ctx.oidc.entities.Grant as OrgGrant | undefined;
      if (grant) await grantAccess(db, env, ctx.oidc.client as Client, sub, grant);
      return account;
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
  provider.registerGrantType(
    ORG_SWITCH_GRANT,
    orgSwitchGrantHandler({ db, env }),
    ORG_SWITCH_PARAMS
  );
  provider.use(addRefreshExpiresIn);
  provider.use(allowPostLogoutRedirect);
  return provider;
}
