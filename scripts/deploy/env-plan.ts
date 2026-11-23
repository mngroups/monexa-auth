import type { DeployConfig } from "./config.js";
import { KEY_NAMES } from "./keys.js";

/**
 * `plain` is stored with `--no-sensitive` (Vercel "plain"/"encrypted": readable by
 * `vercel env pull`); `sensitive` can never be read back.
 */
export type EnvType = "plain" | "sensitive";

export type Desired = {
  key: string;
  type: EnvType;
  /** Fixed config value; synced on every run. */
  value?: string;
  /** Generated once (the permanent keys); an existing value is never replaced. */
  onlyIfMissing?: boolean;
  /** Only the user has it (a personal token): asked for when missing. */
  fromUser?: boolean;
};

export type Action =
  | { kind: "add" | "sync" | "skip" | "askUser"; desired: Desired }
  | { kind: "wrongType"; desired: Desired; actual: string };

/** What each project needs. Neon's DATABASE_URL* and ADMIN_CLIENT_SECRET have their own owners. */
export function desiredEnv(cfg: DeployConfig): { auth: Desired[]; admin: Desired[] } {
  const plain = (key: string, value: string): Desired => ({ key, type: "plain", value });
  const gitlab: Desired[] = [
    plain("GITLAB_PACKAGE_GROUP_ID", cfg.gitlabPackageGroupId),
    { key: "GITLAB_NPM_TOKEN", type: "sensitive", fromUser: true },
  ];
  const hint = cfg.auth.orgHint;
  return {
    auth: [
      ...gitlab,
      plain("OIDC_ISSUER", cfg.issuer),
      plain("TRUST_PROXY", "true"),
      plain("DB_POOL_MAX", "2"),
      plain("ADMIN_REDIRECT_URIS", cfg.adminCallback),
      plain("ADMIN_POST_LOGOUT_REDIRECT_URI", cfg.adminLogout),
      ...(hint ? [plain("ADMIN_ORG_HINT", hint)] : []),
      ...KEY_NAMES.map((key): Desired => ({ key, type: "plain", onlyIfMissing: true })),
    ],
    admin: [
      ...gitlab,
      plain("API_BASE_URL", cfg.issuer),
      plain("AUTH_MODE", "sso"),
      plain("AUTH_PORTAL_URL", cfg.issuer),
      ...(hint ? [plain("AUTH_ORG_HINT", hint)] : []),
    ],
  };
}

const typeOf = (vercelType: string): EnvType =>
  vercelType === "sensitive" || vercelType === "secret" ? "sensitive" : "plain";

/**
 * Compares the project's production env with what it needs. A variable stored with the
 * wrong type is reported, never removed: only a person may delete env on Vercel.
 */
export function planEnv(
  existing: { key: string; type: string; value?: string }[],
  desired: Desired[]
): Action[] {
  const byKey = new Map(existing.map((e) => [e.key, e]));
  return desired.map((d): Action => {
    const found = byKey.get(d.key);
    if (found === undefined) return { kind: d.fromUser ? "askUser" : "add", desired: d };
    if (typeOf(found.type) !== d.type) return { kind: "wrongType", desired: d, actual: found.type };
    if (d.value !== undefined && found.value !== d.value) return { kind: "sync", desired: d };
    return { kind: "skip", desired: d };
  });
}
