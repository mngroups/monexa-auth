import { probeClientSecret } from "../probe.js";

const opts = {
  issuer: "https://auth.example.id",
  clientId: "monexa-admin",
  secret: "s3cret",
  redirectUri: "https://auth-admin.example.id/auth/callback",
};

const reply = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe("probeClientSecret", () => {
  it("treats invalid_grant as a matching secret", async () => {
    expect(await probeClientSecret(reply(400, { error: "invalid_grant" }), opts)).toBe("ok");
  });

  it("reports a secret the provider rejects", async () => {
    expect(await probeClientSecret(reply(401, { error: "invalid_client" }), opts)).toBe(
      "invalid_client"
    );
  });

  it("reports anything else as unexpected", async () => {
    expect(await probeClientSecret(reply(500, {}), opts)).toBe("unexpected:500");
  });

  it("authenticates with client_secret_basic against <issuer>/oidc/token", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    };
    await probeClientSecret(fetchImpl, opts);
    if (!seen) throw new Error("fetch was not called");
    expect(seen.url).toBe("https://auth.example.id/oidc/token");
    const auth = (seen.init.headers as Record<string, string>).authorization;
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      "monexa-admin:s3cret"
    );
  });
});
