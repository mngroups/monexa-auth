import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployConfig } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PLACEHOLDER = "[SENSITIVE]";

/**
 * Arguments for `vercel env run`. It runs from a fresh empty directory: the CLI also loads any
 * `.env` in its working directory, and a local dev value must never mix into production.
 */
export function prodRunArgs(
  project: string,
  team: string,
  root: string,
  script: string,
  args: string[] = []
): { cwd: string; args: string[] } {
  return {
    cwd: mkdtempSync(join(tmpdir(), "deploy-run-")),
    args: [
      "env",
      "run",
      "-e",
      "production",
      "-p",
      project,
      "--scope",
      team,
      "--",
      `${root}node_modules/.bin/tsx`,
      `${root}scripts/deploy/${script}`,
      ...args,
    ],
  };
}

/**
 * Runs a script with the production env loaded only into that child (no env file). Inputs the
 * child needs (a password, a new secret) go through `env`, never argv; the child never hands a
 * secret back: callers create secrets themselves.
 */
export function runWithProdEnv(
  cfg: DeployConfig,
  script: string,
  opts: { args?: string[]; env?: Record<string, string> } = {}
): Promise<number> {
  return new Promise((resolve, reject) => {
    const run = prodRunArgs(cfg.auth.project, cfg.team, repoRoot, script, opts.args);
    const child = spawn("vercel", run.args, {
      cwd: run.cwd,
      // NODE_NO_WARNINGS: pg prints an sslmode notice on every connection.
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...opts.env },
      stdio: "inherit",
    });
    const cleanup = () => rmSync(run.cwd, { recursive: true, force: true });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolve(code ?? 1);
    });
  });
}

/**
 * The direct (non-pooler) database URL for one-off scripts: Neon's synced
 * DATABASE_URL_UNPOOLED first, then MIGRATION_DATABASE_URL. Vercel's placeholder for a
 * value it cannot read never counts.
 */
export function pickDirectUrl(
  env: Record<string, string | undefined>
): { name: string; url: string } | null {
  for (const name of ["DATABASE_URL_UNPOOLED", "MIGRATION_DATABASE_URL"]) {
    const url = env[name];
    if (url && url !== PLACEHOLDER) return { name, url };
  }
  return null;
}

/** Inside a child: point DATABASE_URL at the direct connection; logs the variable's name only. */
export function useDirectDatabaseUrl(): void {
  const direct = pickDirectUrl(process.env);
  if (!direct) throw new Error("no readable direct database URL (DATABASE_URL_UNPOOLED)");
  process.env.DATABASE_URL = direct.url;
  console.log(`· database: ${direct.name}`);
}

/** An error whose message is written by these scripts and never contains a value. */
export class DeployError extends Error {}

/** A driver error's message can carry the query and its params: report only a code. */
export function safeError(err: unknown): string {
  if (err instanceof DeployError) return err.message;
  const e = err as { code?: string; cause?: { code?: string }; name?: string };
  return e.cause?.code ?? e.code ?? e.name ?? "error";
}
