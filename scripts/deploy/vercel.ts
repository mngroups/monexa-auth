import { spawn } from "node:child_process";
import type { EnvType } from "./env-plan.js";

export type RunResult = { code: number; stdout: string; stderr: string };
/** Runs the Vercel CLI. `input` goes to stdin: the only way a value reaches the CLI. */
export type Runner = (args: string[], opts?: { input?: string }) => Promise<RunResult>;

export const runVercelCli: Runner = (args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn("vercel", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    // Written before the CLI starts reading, then closed: no race with a slow producer.
    child.stdin.end(opts?.input ?? "");
  });

export type DeployState = "READY" | "ERROR" | "CANCELED";

/** Thin, testable wrapper over the CLI. Every call is scoped to the team. */
export function createVercel(team: string, run: Runner = runVercelCli, opts = { pollMs: 15_000 }) {
  const scope = ["--scope", team];

  async function api<T = Record<string, unknown>>(
    path: string,
    req: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const args = ["api", path];
    if (req.method) args.push("-X", req.method);
    if (req.body !== undefined) args.push("--input", "-");
    const res = await run([...args, "--raw", ...scope], {
      input: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    let parsed: { error?: { message?: string } } & Record<string, unknown>;
    try {
      parsed = JSON.parse(res.stdout.trim() || "{}");
    } catch {
      throw new Error(`vercel api ${path}: unreadable response (exit ${res.code})`);
    }
    if (parsed.error) throw new Error(`vercel api ${path}: ${parsed.error.message ?? "error"}`);
    if (res.code !== 0) throw new Error(`vercel api ${path}: exit ${res.code}`);
    return parsed as T;
  }

  return {
    api,

    /** Production env of a project: names and types only, never values. */
    async envList(project: string): Promise<{ key: string; type: string }[]> {
      const { envs } = await api<{ envs: { key: string; type: string; target?: string[] }[] }>(
        `/v10/projects/${project}/env`
      );
      return envs
        .filter((e) => e.target?.includes("production"))
        .map((e) => ({ key: e.key, type: e.type }));
    },

    /**
     * Current values of the named config variables only, each read on its own (the list
     * endpoint returns ciphertext). Never asks for any other variable.
     */
    async envValues(project: string, keys: string[]): Promise<Record<string, string>> {
      const { envs } = await api<{ envs: { id: string; key: string; target?: string[] }[] }>(
        `/v10/projects/${project}/env`
      );
      const wanted = new Set(keys);
      const out: Record<string, string> = {};
      for (const e of envs) {
        if (!wanted.has(e.key) || !e.target?.includes("production")) continue;
        const { value } = await api<{ value?: string }>(`/v1/projects/${project}/env/${e.id}`);
        if (value !== undefined) out[e.key] = value;
      }
      return out;
    },

    /** Adds or replaces a production variable; the value travels on stdin only. */
    async envSet(
      project: string,
      key: string,
      value: string,
      type: EnvType,
      mode: "add" | "update"
    ) {
      const args = ["env", mode, key, "production", "-p", project];
      if (mode === "add") args.push(type === "sensitive" ? "--sensitive" : "--no-sensitive");
      else {
        if (type === "sensitive") args.push("--sensitive");
        args.push("--yes");
      }
      const res = await run([...args, ...scope], { input: value });
      if (res.code !== 0) throw new Error(`vercel env ${mode} ${key} failed (exit ${res.code})`);
    },

    async deployFromGit(project: string, repo: string, ref = "main"): Promise<string> {
      const [org, name] = repo.split("/");
      const { id } = await api<{ id: string }>("/v13/deployments", {
        method: "POST",
        body: {
          name: project,
          project,
          target: "production",
          gitSource: { type: "github", org, repo: name, ref },
        },
      });
      return id;
    },

    async waitForDeployment(id: string): Promise<DeployState> {
      for (;;) {
        const { readyState } = await api<{ readyState: string }>(`/v13/deployments/${id}`);
        if (readyState === "READY" || readyState === "ERROR" || readyState === "CANCELED") {
          return readyState;
        }
        await new Promise((r) => setTimeout(r, opts.pollMs));
      }
    },

    async projectDomains(project: string): Promise<string[]> {
      const { domains } = await api<{ domains: { name: string }[] }>(
        `/v9/projects/${project}/domains`
      );
      return domains.map((d) => d.name);
    },

    domainConfig(domain: string) {
      return api<{ misconfigured: boolean; recommendedCNAME?: { value: string }[] }>(
        `/v6/domains/${domain}/config`
      );
    },
  };
}

export type Vercel = ReturnType<typeof createVercel>;
