import { loadDeployConfig } from "../config.js";
import { runSmoke } from "../smoke.js";

const cfg = loadDeployConfig();
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

function healthyFetch(overrides: Record<string, () => Response> = {}) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    for (const [k, v] of Object.entries(overrides)) if (url.includes(k)) return v();
    if (url.endsWith("/health")) return json({ status: "ok" });
    if (url.endsWith("/ready")) return json({ checks: { db: "ok" } });
    if (url.includes("openid-configuration")) {
      return new Response(JSON.stringify({ issuer: `${cfg.issuer}/oidc` }));
    }
    if (url === `https://${cfg.admin.domain}/`) return redirect("/login");
    if (url.endsWith("/login")) return redirect(`https://${cfg.admin.domain}/auth/start`);
    if (url.endsWith("/auth/start")) {
      const q = new URLSearchParams({ client_id: "monexa-admin", redirect_uri: cfg.adminCallback });
      return redirect(`${cfg.issuer}/oidc/auth?${q}`);
    }
    if (url.endsWith("/api/cron/cleanup")) {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return auth === "Bearer cron" ? json({ deleted: 0 }) : json(null, 401);
    }
    return new Response("?", { status: 404 });
  };
}

describe("runSmoke", () => {
  it("passes every check on a healthy deployment", async () => {
    const results = await runSmoke(healthyFetch(), cfg, { cronSecret: "cron" });
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results.map((r) => r.name)).toEqual([
      "auth /health",
      "auth /ready",
      "oidc discovery",
      "admin sign-in redirect",
      "cron rejects no token",
      "cron runs with token",
    ]);
  });

  it("skips the authorized cron call without a secret", async () => {
    const names = (await runSmoke(healthyFetch(), cfg)).map((r) => r.name);
    expect(names).not.toContain("cron runs with token");
  });

  it("names the failing check", async () => {
    const results = await runSmoke(
      healthyFetch({ "/ready": () => json({ checks: { db: "fail" } }, 503) }),
      cfg
    );
    expect(results.find((r) => r.name === "auth /ready")).toMatchObject({ ok: false });
  });

  it("catches a sign-in redirect to the wrong client", async () => {
    const results = await runSmoke(
      healthyFetch({ "/auth/start": () => redirect(`${cfg.issuer}/oidc/auth?client_id=other`) }),
      cfg
    );
    expect(results.find((r) => r.name === "admin sign-in redirect")?.ok).toBe(false);
  });

  it("reports a network error as a failed check instead of throwing", async () => {
    const results = await runSmoke(
      healthyFetch({
        "/health": () => {
          throw new Error("ECONNREFUSED");
        },
      }),
      cfg
    );
    expect(results[0]).toMatchObject({ name: "auth /health", ok: false });
  });
});
