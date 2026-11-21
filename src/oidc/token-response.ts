import type { KoaContextWithOIDC } from "oidc-provider";
import { appClient } from "./grant-access.js";

type Next = () => Promise<void>;

/**
 * Provider middleware: `/token` responses that carry a refresh token also say when it
 * expires (`refresh_expires_in` = the app's `refresh_ttl_seconds`), as the kit expects.
 */
export async function addRefreshExpiresIn(ctx: KoaContextWithOIDC, next: Next): Promise<void> {
  await next();
  // `ctx.oidc` exists only on the provider's own routes.
  if (ctx.oidc?.route !== "token" || !ctx.oidc.client) return;
  const body = ctx.body as Record<string, unknown> | undefined;
  if (typeof body?.refresh_token !== "string") return;
  body.refresh_expires_in = appClient(ctx.oidc.client).refresh_ttl_seconds;
}
