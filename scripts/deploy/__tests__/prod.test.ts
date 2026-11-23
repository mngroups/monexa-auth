import { prodRunArgs } from "../prod.js";

describe("prodRunArgs", () => {
  it("runs the script from an empty directory so no local .env is loaded", () => {
    const { cwd, args } = prodRunArgs("monexa-auth", "team-x", "/repo/", "smoke-run.ts", ["--x"]);
    expect(cwd).not.toBe("/repo/");
    expect(cwd).toMatch(/deploy-run-/);
    expect(args).toEqual([
      "env",
      "run",
      "-e",
      "production",
      "-p",
      "monexa-auth",
      "--scope",
      "team-x",
      "--",
      "/repo/node_modules/.bin/tsx",
      "/repo/scripts/deploy/smoke-run.ts",
      "--x",
    ]);
  });
});
