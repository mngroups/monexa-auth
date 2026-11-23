import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeployConfig } from "./config.js";

const SECRET_MARKER = "__DEPLOY_SECRET__:";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

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
 * Runs a script under `vercel env run -e production`, so the production env exists only in
 * that child process: no env file is written. The child hands a secret back by printing one
 * marker line on stdout; every other line is echoed.
 */
export function runWithProdEnv(
  cfg: DeployConfig,
  script: string,
  opts: { args?: string[]; env?: Record<string, string> } = {}
): Promise<{ code: number; secret: string | null }> {
  return new Promise((resolve, reject) => {
    const run = prodRunArgs(cfg.auth.project, cfg.team, repoRoot, script, opts.args);
    const child = spawn("vercel", run.args, {
      cwd: run.cwd,
      // NODE_NO_WARNINGS: pg prints an sslmode notice on every connection.
      env: { ...process.env, NODE_NO_WARNINGS: "1", ...opts.env },
      stdio: ["inherit", "pipe", "inherit"],
    });
    let secret: string | null = null;
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith(SECRET_MARKER)) secret = line.slice(SECRET_MARKER.length);
        else process.stdout.write(`${line}\n`);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (buffer && !buffer.startsWith(SECRET_MARKER)) process.stdout.write(buffer);
      resolve({ code: code ?? 1, secret });
    });
  });
}

/** Inside a `runWithProdEnv` child: hands a secret to the parent without printing it. */
export function emitSecret(value: string): void {
  process.stdout.write(`${SECRET_MARKER}${value}\n`);
}

/** Inside a child: migrations and one-off scripts use the direct connection, not the pooler. */
export function useDirectDatabaseUrl(): void {
  const direct = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
  if (direct && direct !== "[SENSITIVE]") process.env.DATABASE_URL = direct;
}
