import { createVercel, type Runner } from "../vercel.js";

type Call = { args: string[]; input?: string };

function fakeRunner(replies: Record<string, string> = {}, code = 0) {
  const calls: Call[] = [];
  const run: Runner = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    const key = Object.keys(replies).find((k) => args.join(" ").includes(k));
    return { code, stdout: key ? replies[key] : "{}", stderr: "" };
  };
  return { run, calls };
}

describe("vercel wrapper", () => {
  it("passes an env value on stdin, never in argv", async () => {
    const { run, calls } = fakeRunner();
    const v = createVercel("team-x", run);
    await v.envSet("proj", "CLIENT_SECRET_KEY", "super-secret-value", "plain", "add");
    await v.envSet("proj", "GITLAB_NPM_TOKEN", "glpat-secret", "sensitive", "update");
    for (const c of calls) {
      expect(c.args.join(" ")).not.toContain("secret-value");
      expect(c.args.join(" ")).not.toContain("glpat");
    }
    expect(calls[0]).toEqual({
      args: [
        "env",
        "add",
        "CLIENT_SECRET_KEY",
        "production",
        "-p",
        "proj",
        "--no-sensitive",
        "--scope",
        "team-x",
      ],
      input: "super-secret-value",
    });
    expect(calls[1].args).toEqual([
      "env",
      "update",
      "GITLAB_NPM_TOKEN",
      "--environment",
      "production",
      "-p",
      "proj",
      "--sensitive",
      "--yes",
      "--scope",
      "team-x",
    ]);
  });

  it("keeps a plain variable plain on update (CLI 66 defaults production to sensitive)", async () => {
    const { run, calls } = fakeRunner();
    await createVercel("t", run).envSet("proj", "AUTH_MODE", "sso", "plain", "update");
    expect(calls[0].args).toEqual([
      "env",
      "update",
      "AUTH_MODE",
      "--environment",
      "production",
      "-p",
      "proj",
      "--type",
      "config",
      "--yes",
      "--scope",
      "t",
    ]);
    expect(calls[0].input).toBe("sso");
  });

  it("fails without echoing the value when the CLI rejects it", async () => {
    const { run } = fakeRunner({}, 1);
    const v = createVercel("team-x", run);
    await expect(v.envSet("proj", "K", "hidden-value", "plain", "add")).rejects.toThrow(
      /env add K failed/
    );
    await expect(v.envSet("proj", "K", "hidden-value", "plain", "add")).rejects.not.toThrow(
      /hidden-value/
    );
  });

  it("lists production env as key and type only", async () => {
    const { run, calls } = fakeRunner({
      "/v10/projects/proj/env": `\n${JSON.stringify({
        envs: [
          { key: "A", type: "plain", target: ["production"], value: "leak?" },
          { key: "B", type: "sensitive", target: ["preview"] },
        ],
      })}`,
    });
    const list = await createVercel("team-x", run).envList("proj");
    expect(list).toEqual([{ key: "A", type: "plain" }]);
    expect(calls[0].args).toEqual(["api", "/v10/projects/proj/env", "--raw", "--scope", "team-x"]);
  });

  it("reads back only the config values it is asked for, one variable at a time", async () => {
    const { run, calls } = fakeRunner({
      "/v1/projects/proj/env/e1": JSON.stringify({ value: "https://a", decrypted: true }),
      "/v10/projects/proj/env": JSON.stringify({
        envs: [
          { id: "e1", key: "OIDC_ISSUER", type: "plain", target: ["production"], value: "eyJ…" },
          { id: "e2", key: "CLIENT_SECRET_KEY", type: "plain", target: ["production"] },
        ],
      }),
    });
    const values = await createVercel("t", run).envValues("proj", ["OIDC_ISSUER"]);
    expect(values).toEqual({ OIDC_ISSUER: "https://a" });
    const paths = calls.map((c) => c.args[1]);
    expect(paths).toEqual(["/v10/projects/proj/env", "/v1/projects/proj/env/e1"]);
  });

  it("lists a project's domains by name", async () => {
    const { run } = fakeRunner({
      "/v9/projects/proj/domains": JSON.stringify({ domains: [{ name: "a.example.id" }] }),
    });
    expect(await createVercel("t", run).projectDomains("proj")).toEqual(["a.example.id"]);
  });

  it("sends an API body on stdin", async () => {
    const { run, calls } = fakeRunner({ "/v13/deployments": JSON.stringify({ id: "dpl_1" }) });
    const id = await createVercel("t", run).deployFromGit("proj", "org/proj", "main");
    expect(id).toBe("dpl_1");
    expect(calls[0].args).toEqual([
      "api",
      "/v13/deployments",
      "-X",
      "POST",
      "--input",
      "-",
      "--raw",
      "--scope",
      "t",
    ]);
    expect(JSON.parse(calls[0].input ?? "")).toMatchObject({
      project: "proj",
      target: "production",
      gitSource: { type: "github", org: "org", repo: "proj", ref: "main" },
    });
  });

  it("surfaces an API error message", async () => {
    const { run } = fakeRunner({ "/v9/projects": JSON.stringify({ error: { message: "nope" } }) });
    await expect(createVercel("t", run).api("/v9/projects/x")).rejects.toThrow(/nope/);
  });

  it("stops waiting on a failed deployment", async () => {
    const states = ["BUILDING", "ERROR"];
    const run: Runner = async () => ({
      code: 0,
      stdout: JSON.stringify({ readyState: states.shift() }),
      stderr: "",
    });
    const v = createVercel("t", run, { pollMs: 0 });
    await expect(v.waitForDeployment("dpl_1")).resolves.toBe("ERROR");
  });
});
