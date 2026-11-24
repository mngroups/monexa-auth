import { readFileSync } from "node:fs";
import { z } from "zod";

const hostname = z
  .string()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "a bare hostname (no scheme, no path)");
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name");

const schema = z.object({
  team: z.string().min(1),
  region: z.string().min(1),
  gitlabPackageGroupId: z.string().regex(/^\d+$/),
  auth: z.object({
    project: z.string().min(1),
    repo,
    domain: hostname,
    orgHint: z.string().min(1).optional(),
  }),
  admin: z.object({ project: z.string().min(1), repo, domain: hostname }),
});

export type DeployConfig = z.infer<typeof schema> & {
  /** `OIDC_ISSUER` (apps use `<issuer>/oidc`). Permanent once users exist. */
  issuer: string;
  adminCallback: string;
  adminLogout: string;
};

const DEFAULT_PATH = new URL("../../deploy/vercel.config.json", import.meta.url).pathname;

/** Reads `deploy/vercel.config.json` (non-secret values only) and derives the public URLs. */
export function loadDeployConfig(path: string = DEFAULT_PATH): DeployConfig {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid deploy config (${path}): ${where.join("; ")}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    issuer: `https://${cfg.auth.domain}`,
    adminCallback: `https://${cfg.admin.domain}/auth/callback`,
    adminLogout: `https://${cfg.admin.domain}/login`,
  };
}
