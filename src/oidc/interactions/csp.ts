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
