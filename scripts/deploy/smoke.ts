import type { DeployConfig } from "./config.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type Check = { name: string; ok: boolean; detail: string };

async function check(name: string, fn: () => Promise<string | true>): Promise<Check> {
  try {
    const out = await fn();
    return out === true ? { name, ok: true, detail: "ok" } : { name, ok: false, detail: out };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
}

const data = async (res: Response) => ((await res.json()) as { data?: unknown }).data;

/** Post-deploy checks against production. Never sends or prints a secret beyond the cron bearer. */
export async function runSmoke(
  fetchImpl: Fetch,
  cfg: DeployConfig,
  opts: { cronSecret?: string } = {}
): Promise<Check[]> {
  const admin = `https://${cfg.admin.domain}`;
  const noFollow: RequestInit = { redirect: "manual" };
  const location = async (url: string) => {
    const res = await fetchImpl(url, noFollow);
    const to = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !to) throw new Error(`${url} → ${res.status}`);
    return new URL(to, url).toString();
  };

  const checks = [
    check("auth /health", async () => {
      const res = await fetchImpl(`${cfg.issuer}/health`);
      return res.ok || `status ${res.status}`;
    }),
    check("auth /ready", async () => {
      const res = await fetchImpl(`${cfg.issuer}/ready`);
      const body = (await data(res)) as { checks?: { db?: string } } | undefined;
      return (
        (res.ok && body?.checks?.db === "ok") || `status ${res.status}, db ${body?.checks?.db}`
      );
    }),
    check("oidc discovery", async () => {
      const res = await fetchImpl(`${cfg.issuer}/oidc/.well-known/openid-configuration`);
      const { issuer } = (await res.json()) as { issuer?: string };
      return issuer === `${cfg.issuer}/oidc` || `issuer ${issuer}`;
    }),
    check("admin sign-in redirect", async () => {
      const login = await location(`${admin}/`);
      const start = await location(login);
      const authorize = new URL(await location(start));
      const ok =
        authorize.origin + authorize.pathname === `${cfg.issuer}/oidc/auth` &&
        authorize.searchParams.get("client_id") === "monexa-admin" &&
        authorize.searchParams.get("redirect_uri") === cfg.adminCallback;
      return ok || `ended at ${authorize.origin}${authorize.pathname}`;
    }),
    check("cron rejects no token", async () => {
      const res = await fetchImpl(`${cfg.issuer}/api/cron/cleanup`);
      return res.status === 401 || `status ${res.status}`;
    }),
  ];
  if (opts.cronSecret) {
    checks.push(
      check("cron runs with token", async () => {
        const res = await fetchImpl(`${cfg.issuer}/api/cron/cleanup`, {
          headers: { authorization: `Bearer ${opts.cronSecret}` },
        });
        return res.ok || `status ${res.status}`;
      })
    );
  }
  return Promise.all(checks);
}
