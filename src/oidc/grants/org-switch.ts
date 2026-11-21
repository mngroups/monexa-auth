import { eq } from "drizzle-orm";
import { errors, type TokenEndpointGrantContext } from "oidc-provider";
import { resolveAccess } from "../../access/permissions.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import {
  appClient,
  grantRefused,
  type OrgGrant,
  resourceIndicator,
  resourceServerInfo,
} from "../grant-access.js";

export const ORG_SWITCH_GRANT = "urn:monexa:params:oauth:grant-type:org-switch";
export const ORG_SWITCH_PARAMS = ["refresh_token", "org_id"] as const;

type OrgSwitchParams = { refresh_token?: string; org_id?: string };

/**
 * The org-switch grant: trades a valid refresh token of the authenticating client for a
 * new Grant, access token and refresh token in another org the user may enter. The old
 * Grant (and every token of it) is revoked and `last_org_id` follows the switch.
 */
export function orgSwitchGrantHandler({ db, env }: { db: Db; env: Env }) {
  return async (ctx: TokenEndpointGrantContext<OrgSwitchParams>): Promise<void> => {
    const { client, params, provider } = ctx.oidc;
    const { refresh_token: refreshTokenValue, org_id: orgId } = params;
    if (!refreshTokenValue || !orgId) {
      throw new errors.InvalidRequest("refresh_token and org_id are required");
    }

    const old = await provider.RefreshToken.find(refreshTokenValue);
    if (!old) throw new errors.InvalidGrant("refresh token not found");
    if (old.clientId !== client.clientId) throw new errors.InvalidGrant("client mismatch");
    const oldGrantId = old.grantId;
    const oldGrant = oldGrantId ? await provider.Grant.find(oldGrantId) : undefined;
    if (!oldGrant || oldGrant.accountId !== old.accountId) {
      throw new errors.InvalidGrant("grant not found");
    }
    if (old.consumed) {
      await revokeGrant(provider, oldGrantId as string);
      throw new errors.InvalidGrant("refresh token already used");
    }

    const userId = old.accountId as string;
    const [user] = await db
      .select({ isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId));
    if (!user?.isActive) throw grantRefused("invalid_credentials");

    const access = await resolveAccess(db, {
      userId,
      appId: appClient(client).app_id,
      orgId,
      adminClientId: env.ADMIN_CLIENT_ID,
    });
    if (!access.ok) throw grantRefused(access.reason);

    // Consuming first lets only one of two concurrent switches with the same token win.
    await old.consume();

    const grant = new provider.Grant({ accountId: userId, clientId: client.clientId }) as OrgGrant;
    grant.orgId = access.org.id;
    grant.addOIDCScope("openid");
    const grantId = await grant.save();
    ctx.oidc.entity("Grant", grant);

    const resource = resourceIndicator(client);
    const at = new provider.AccessToken({
      accountId: userId,
      client,
      grantId,
      gty: "org-switch",
      scope: "",
      resourceServer: new provider.ResourceServer(resource, resourceServerInfo(client)),
    });
    ctx.oidc.entity("AccessToken", at);
    const accessToken = await at.save();

    const rt = new provider.RefreshToken({
      accountId: userId,
      client,
      grantId,
      gty: "org-switch",
      scope: "openid",
      resource,
      rotations: 0,
    });
    ctx.oidc.entity("RefreshToken", rt);
    const refreshToken = await rt.save();

    await revokeGrant(provider, oldGrantId as string);
    await db.update(users).set({ lastOrgId: access.org.id }).where(eq(users.id, userId));

    ctx.body = {
      access_token: accessToken,
      expires_in: at.expiration,
      refresh_token: refreshToken,
      token_type: at.tokenType,
    };
  };
}

async function revokeGrant(
  provider: TokenEndpointGrantContext["oidc"]["provider"],
  grantId: string
) {
  await Promise.all([
    provider.AccessToken.revokeByGrantId(grantId),
    provider.RefreshToken.revokeByGrantId(grantId),
    provider.Grant.adapter.destroy(grantId),
  ]);
}
