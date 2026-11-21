import { eq } from "drizzle-orm";
import { errors, type TokenEndpointGrantContext } from "oidc-provider";
import { resolveAccess } from "../../access/permissions.js";
import { logActivity } from "../../activity/log.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { findUserByIdentifier } from "../../users/lookup.js";
import { checkPasswordLogin } from "../../users/passwords.js";
import {
  appClient,
  type GrantRefusal,
  grantRefused,
  type OrgGrant,
  resourceIndicator,
  resourceServerInfo,
} from "../grant-access.js";

export const PASSWORD_GRANT_PARAMS = ["username", "password", "org_id", "scope"] as const;

type PasswordParams = { username?: string; password?: string; org_id?: string };

/**
 * The `password` grant (credentials mode): verifies the user with lockout, picks the org
 * (`org_id`, else last used, else first eligible), stores it on a new Grant and issues a
 * JWT access token plus a refresh token. Clients get it only with `password` in
 * `allowed_grants` (their `grant_types`; the provider answers `unauthorized_client`).
 */
export function passwordGrantHandler({ db, env }: { db: Db; env: Env }) {
  return async (ctx: TokenEndpointGrantContext<PasswordParams>): Promise<void> => {
    const { client, params, provider } = ctx.oidc;
    const { username, password } = params;
    if (!username || !password) {
      throw new errors.InvalidRequest("username and password are required");
    }
    const audit = { ip: ctx.ip, userAgent: ctx.get("user-agent") || undefined };

    async function refuse(reason: GrantRefusal, userId: string | null) {
      await logActivity(db, {
        actorUserId: userId,
        orgId: null,
        action: "auth.login.failed",
        targetType: "user",
        // Never the submitted identifier: users sometimes type their password into it.
        targetId: userId ?? "unknown",
        ...audit,
        metadata: { client_id: client.clientId, reason },
      });
      return grantRefused(reason);
    }

    const login = await checkPasswordLogin(db, username, password, {
      maxFailures: env.LOCKOUT_MAX_FAILURES,
      lockMinutes: env.LOCKOUT_MINUTES,
    });
    if (!login.ok) {
      const known = await findUserByIdentifier(db, username);
      throw await refuse(login.reason, known?.id ?? null);
    }
    const { user } = login;

    const access = await resolveAccess(db, {
      userId: user.id,
      appId: appClient(client).app_id,
      orgId: params.org_id,
      lastOrgId: user.lastOrgId,
      adminClientId: env.ADMIN_CLIENT_ID,
    });
    if (!access.ok) throw await refuse(access.reason, user.id);

    const grant = new provider.Grant({ accountId: user.id, clientId: client.clientId }) as OrgGrant;
    grant.orgId = access.org.id;
    grant.addOIDCScope("openid");
    const grantId = await grant.save();
    ctx.oidc.entity("Grant", grant);

    const resource = resourceIndicator(client);
    const at = new provider.AccessToken({
      accountId: user.id,
      client,
      grantId,
      gty: "password",
      scope: "",
      resourceServer: new provider.ResourceServer(resource, resourceServerInfo(client)),
    });
    ctx.oidc.entity("AccessToken", at);
    const accessToken = await at.save();

    const rt = new provider.RefreshToken({
      accountId: user.id,
      client,
      grantId,
      gty: "password",
      scope: "openid",
      resource,
      rotations: 0,
    });
    ctx.oidc.entity("RefreshToken", rt);
    const refreshToken = await rt.save();

    await db.update(users).set({ lastOrgId: access.org.id }).where(eq(users.id, user.id));
    await logActivity(db, {
      actorUserId: user.id,
      orgId: access.org.id,
      action: "auth.login.succeeded",
      targetType: "user",
      targetId: user.id,
      ...audit,
      metadata: { client_id: client.clientId },
    });

    ctx.body = {
      access_token: accessToken,
      expires_in: at.expiration,
      refresh_token: refreshToken,
      token_type: at.tokenType,
    };
  };
}
