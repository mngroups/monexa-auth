type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Checks a client secret against the live token endpoint without logging anyone in: a
 * made-up code fails with `invalid_grant` once the client authenticated, and with
 * `invalid_client` when the secret is wrong.
 */
export async function probeClientSecret(
  fetchImpl: Fetch,
  o: { issuer: string; clientId: string; secret: string; redirectUri: string }
): Promise<"ok" | "invalid_client" | `unexpected:${number}`> {
  const basic = Buffer.from(
    `${encodeURIComponent(o.clientId)}:${encodeURIComponent(o.secret)}`
  ).toString("base64");
  const res = await fetchImpl(`${o.issuer}/oidc/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: "deploy-probe-invalid-code",
      redirect_uri: o.redirectUri,
      code_verifier: "x".repeat(43),
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error === "invalid_grant") return "ok";
  if (body.error === "invalid_client") return "invalid_client";
  return `unexpected:${res.status}`;
}
