// `pnpm deploy:setup [--dry-run]`: creates or repairs both Vercel projects, the Neon database,
// the production env (config, the four permanent keys, the GitLab token) and the domains.
// Safe to re-run: existing keys are never regenerated, and nothing is ever deleted.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type DeployConfig, loadDeployConfig } from "./config.js";
import { type Action, desiredEnv, planEnv } from "./env-plan.js";
import { generateKeys, type KeyName, validateKeys } from "./keys.js";
import { ask } from "./prompt.js";
import { createVercel } from "./vercel.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("usage: pnpm deploy:setup [--dry-run]");
  console.log("  --dry-run  print what would change; change nothing");
  process.exit(0);
}
const dry = args.includes("--dry-run");
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cfg = loadDeployConfig();
const v = createVercel(cfg.team);
const problems: string[] = [];

type Project = {
  id: string;
  accountId: string;
  framework: string | null;
  nodeVersion?: string;
  link?: { repo?: string; org?: string };
};

async function projectExists(project: string): Promise<boolean> {
  try {
    await v.api(`/v9/projects/${project}`);
    return true;
  } catch {
    return false;
  }
}

async function ensureProject(side: "auth" | "admin"): Promise<Project | null> {
  const { project, repo } = cfg[side];
  const framework = side === "auth" ? null : "nextjs";
  let p: Project | null = null;
  try {
    p = await v.api<Project>(`/v9/projects/${project}`);
  } catch {
    console.log(`• ${project}: missing → create`);
    if (dry) return null;
    p = await v.api<Project>("/v11/projects", {
      method: "POST",
      body: { name: project, framework },
    });
  }
  const linked = p.link?.org && p.link?.repo ? `${p.link.org}/${p.link.repo}` : null;
  if (linked !== repo) {
    console.log(`• ${project}: link GitHub ${repo}`);
    if (!dry) {
      await v.api(`/v9/projects/${project}/link`, {
        method: "POST",
        body: { type: "github", repo },
      });
    }
  }
  if (p.framework !== framework || p.nodeVersion !== "24.x") {
    console.log(`• ${project}: framework ${framework ?? "Other"}, Node 24.x`);
    if (!dry) {
      await v.api(`/v9/projects/${project}`, {
        method: "PATCH",
        body: { framework, nodeVersion: "24.x" },
      });
    }
  }
  console.log(`✓ ${project}: project`);
  return p;
}

/** `vercel integration add` works on the linked project: write the link without `vercel link` (it edits .gitignore). */
function linkLocally(p: Project) {
  const dir = `${repoRoot}.vercel`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/project.json`, JSON.stringify({ projectId: p.id, orgId: p.accountId }));
  // `.git` is a file in a worktree; ask git where the exclude file lives.
  const gitPath = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: repoRoot });
  const exclude = resolve(repoRoot, gitPath.stdout.toString().trim());
  if (existsSync(exclude) && !readFileSync(exclude, "utf8").split("\n").includes(".vercel")) {
    appendFileSync(exclude, "\n.vercel\n");
  }
}

async function ensureDatabase(p: Project | null) {
  const env = p ? await v.envList(cfg.auth.project) : [];
  if (env.some((e) => e.key === "DATABASE_URL_UNPOOLED")) {
    console.log("✓ database: Neon connected");
    return;
  }
  console.log(`• database: create Neon (${cfg.region}, Free, production)`);
  if (dry || !p) return;
  linkLocally(p);
  const res = spawnSync(
    "vercel",
    [
      "integration",
      "add",
      "neon",
      "--name",
      `${cfg.auth.project}-db`,
      "--meta",
      `region=${cfg.region}`,
      "-e",
      "production",
      "--no-env-pull",
      "--scope",
      cfg.team,
    ],
    { cwd: repoRoot, stdio: "inherit" }
  );
  if (res.status !== 0)
    problems.push(
      "Neon could not be created (accept its terms once: vercel integration accept-terms neon)"
    );
}

let gitlabToken: string | undefined;
async function apply(project: string, actions: Action[], keys: Record<KeyName, string>) {
  for (const a of actions) {
    const { key, type } = a.desired;
    if (a.kind === "skip") continue;
    if (a.kind === "wrongType") {
      problems.push(
        `${project}: ${key} is ${a.actual}, must be ${type === "plain" ? "--no-sensitive" : "--sensitive"}. ` +
          `Remove it yourself (vercel env rm ${key} production -p ${project} --yes), then re-run setup.`
      );
      continue;
    }
    console.log(`• ${project}: ${a.kind} ${key}${a.kind === "sync" ? "" : ` (${type})`}`);
    if (dry) continue;
    if (a.kind === "askUser") {
      gitlabToken ??= await ask(`${key} (hidden): `, { hidden: true });
      if (!gitlabToken) {
        problems.push(`${project}: ${key} not set`);
        continue;
      }
      await v.envSet(project, key, gitlabToken, type, "add");
      continue;
    }
    const value = a.desired.value ?? keys[key as KeyName];
    await v.envSet(project, key, value, type, a.kind === "add" ? "add" : "update");
  }
}

async function ensureDomain(side: "auth" | "admin") {
  const { project, domain } = cfg[side];
  const attached = await v.projectDomains(project).catch(() => [] as string[]);
  if (!attached.includes(domain)) {
    console.log(`• ${project}: add domain ${domain}`);
    if (!dry) {
      await v.api(`/v10/projects/${project}/domains`, { method: "POST", body: { name: domain } });
    }
  }
  const conf = await v.domainConfig(domain).catch(() => null);
  if (conf && !conf.misconfigured) console.log(`✓ ${domain}: DNS ok`);
  else {
    const cname = conf?.recommendedCNAME?.[0]?.value ?? "(see the project's Domains page)";
    problems.push(`DNS: add CNAME ${domain.split(".")[0]} → ${cname}`);
  }
}

async function main(c: DeployConfig) {
  console.log(
    `${dry ? "Dry run" : "Setup"} for ${c.auth.project} + ${c.admin.project} (${c.team})\n`
  );
  const auth = await ensureProject("auth");
  await ensureProject("admin");
  await ensureDatabase(auth);

  const keys = generateKeys();
  if (validateKeys(keys).length > 0) throw new Error("key generation failed");
  const desired = desiredEnv(c);
  for (const side of ["auth", "admin"] as const) {
    const project = c[side].project;
    const configKeys = desired[side].filter((d) => d.value !== undefined).map((d) => d.key);
    // Never plan against an unknown state: a failed read must stop setup, not look like
    // "nothing exists" (that would plan fresh keys). A project missing in a dry run has no env.
    const missingInDryRun = dry && !(await projectExists(project));
    const values = missingInDryRun ? {} : await v.envValues(project, configKeys);
    const existing = (missingInDryRun ? [] : await v.envList(project)).map((e) => ({
      ...e,
      value: values[e.key],
    }));
    await apply(project, planEnv(existing, desired[side]), keys);
  }
  console.log("✓ env");
  await ensureDomain("auth");
  await ensureDomain("admin");

  if (problems.length > 0) {
    console.log("\nNeeds you:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    dry
      ? "\nDry run: nothing changed."
      : "\nReady. Next: pnpm deploy:release auth, then pnpm deploy:bootstrap (first time only)."
  );
}

await main(cfg);
