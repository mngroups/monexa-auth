import { auth } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { Env } from "../env.js";
import { OIDC_PREFIX } from "../oidc/mount.js";

/**
 * `/v1/auth/*` for the admin UI: this service is also the admin app's backend, so the admin
 * FE uses `@mono/auth` like any app. The kit plugin is `fastify-plugin`-wrapped and adds a
 * bearer check to every route of the context it is registered in, so it lives in its own
 * child scope: provider, interaction, `/api/*` and branding routes never see that hook.
 */
export async function adminClientAuth(
  app: FastifyInstance,
  opts: { env: Env; clientSecret: string }
) {
  const { env } = opts;
  await app.register(async (scope) => {
    await scope.register(auth, {
      mode: "sso",
      issuer: `${env.OIDC_ISSUER}${OIDC_PREFIX}`,
      clientId: env.ADMIN_CLIENT_ID,
      clientSecret: opts.clientSecret,
      redirectUris: env.ADMIN_REDIRECT_URIS,
      postLogoutRedirectUri: env.ADMIN_POST_LOGOUT_REDIRECT_URI,
      orgHint: env.ADMIN_ORG_HINT,
    });
  });
}
