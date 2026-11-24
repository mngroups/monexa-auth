import { DeployError, pickDirectUrl, prodRunArgs, safeError } from "../prod.js";

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

describe("pickDirectUrl", () => {
  it("prefers Neon's synced DATABASE_URL_UNPOOLED and names what it chose", () => {
    expect(
      pickDirectUrl({
        DATABASE_URL_UNPOOLED: "postgres://u",
        MIGRATION_DATABASE_URL: "postgres://m",
      })
    ).toEqual({ name: "DATABASE_URL_UNPOOLED", url: "postgres://u" });
  });

  it("skips Vercel's [SENSITIVE] placeholder", () => {
    expect(
      pickDirectUrl({
        DATABASE_URL_UNPOOLED: "[SENSITIVE]",
        MIGRATION_DATABASE_URL: "postgres://m",
      })
    ).toEqual({ name: "MIGRATION_DATABASE_URL", url: "postgres://m" });
    expect(pickDirectUrl({ MIGRATION_DATABASE_URL: "[SENSITIVE]" })).toBeNull();
  });
});

describe("safeError", () => {
  it("keeps our own messages, which never carry values", () => {
    expect(safeError(new DeployError("app monexa-admin not found"))).toBe(
      "app monexa-admin not found"
    );
  });

  it("reports only a code for driver errors, whose message can hold query params", () => {
    const drizzle = Object.assign(new Error("Failed query: update …\nparams: CIPHERTEXT"), {
      cause: { code: "23505" },
    });
    expect(safeError(drizzle)).toBe("23505");
    expect(safeError(new Error("params: CIPHERTEXT"))).toBe("Error");
  });
});
