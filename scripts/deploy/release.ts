// `pnpm deploy:release [auth|admin|all]`: deploys `main` from GitHub, waits, then smoke tests.
import { type DeployConfig, loadDeployConfig } from "./config.js";
import { runWithProdEnv } from "./prod.js";
import { createVercel, type Vercel } from "./vercel.js";

type Target = "auth" | "admin";

export async function release(cfg: DeployConfig, v: Vercel, targets: Target[]): Promise<boolean> {
  const started = await Promise.all(
    targets.map(async (t) => {
      const id = await v.deployFromGit(cfg[t].project, cfg[t].repo, "main");
      console.log(`▶ ${cfg[t].project}: deploying main (${id})`);
      return { t, id };
    })
  );
  let ok = true;
  for (const { t, id } of started) {
    const state = await v.waitForDeployment(id);
    console.log(`${state === "READY" ? "✓" : "✗"} ${cfg[t].project}: ${state}`);
    if (state !== "READY") {
      console.log(`  logs: vercel inspect ${id} --logs --scope ${cfg.team}`);
      ok = false;
    }
  }
  if (!ok) return false;
  // Smoke runs with the production env loaded only into that process (the cron bearer).
  const { code } = await runWithProdEnv(cfg, "smoke-run.ts");
  return code === 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2] ?? "all";
  if (arg === "--help" || !["auth", "admin", "all"].includes(arg)) {
    console.log("usage: pnpm deploy:release [auth|admin|all]");
    process.exit(arg === "--help" ? 0 : 1);
  }
  const cfg = loadDeployConfig();
  const targets: Target[] = arg === "all" ? ["auth", "admin"] : [arg as Target];
  const ok = await release(cfg, createVercel(cfg.team), targets);
  process.exit(ok ? 0 : 1);
}
