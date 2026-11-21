import type { KoaContextWithOIDC } from "oidc-provider";

/**
 * Widens helmet's `form-action 'self'` by the one origin this page's form ends up at.
 * Browsers apply form-action to the redirects after a submit too (login → provider → the
 * app's callback; logout → the app's logged-out page), so that origin must be allowed, while
 * every other target stays blocked: the backstop against an injected form exfiltrating the
 * typed password. `target` must already be validated (a registered redirect URI).
 */
export function allowFormRedirect(
  csp: string | undefined,
  target: string | undefined
): string | undefined {
  const origin = target ? URL.parse(target)?.origin : undefined;
  if (!csp || !origin || origin === "null") return csp;
  return csp.replace(/form-action 'self'/, `form-action 'self' ${origin}`);
}

/**
 * Provider middleware: both pages `/session/end` can serve (our logout page with a session,
 * the provider's auto-submit form without one) post to the confirm endpoint, which redirects
 * to the post_logout_redirect_uri the provider has validated by then; allow its origin.
 */
export async function allowPostLogoutRedirect(
  ctx: KoaContextWithOIDC,
  next: () => Promise<void>
): Promise<void> {
  await next();
  // `ctx.oidc` exists only on the provider's own routes.
  if (ctx.oidc?.route !== "end_session") return;
  const target = ctx.oidc.params?.post_logout_redirect_uri as string | undefined;
  const csp = allowFormRedirect(ctx.response.get("content-security-policy"), target);
  if (csp) ctx.set("content-security-policy", csp);
}
