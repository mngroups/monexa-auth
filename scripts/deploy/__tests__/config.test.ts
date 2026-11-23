import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeployConfig } from "../config.js";

const base = {
  team: "team-x",
  region: "sin1",
  gitlabPackageGroupId: "123",
  auth: { project: "a", repo: "org/a", domain: "auth.example.id", orgHint: "acme" },
  admin: { project: "b", repo: "org/b", domain: "auth-admin.example.id" },
};

function write(value: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "deploy-config-")), "c.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("loadDeployConfig", () => {
  it("derives the issuer and the admin URLs from the domains", () => {
    const cfg = loadDeployConfig(write(base));
    expect(cfg.issuer).toBe("https://auth.example.id");
    expect(cfg.adminCallback).toBe("https://auth-admin.example.id/auth/callback");
    expect(cfg.adminLogout).toBe("https://auth-admin.example.id/login");
  });

  it("rejects a domain written as a URL", () => {
    const bad = { ...base, auth: { ...base.auth, domain: "https://auth.example.id" } };
    expect(() => loadDeployConfig(write(bad))).toThrow(/auth\.domain/);
  });

  it("rejects a repo that is not owner/name", () => {
    const bad = { ...base, admin: { ...base.admin, repo: "just-a-name" } };
    expect(() => loadDeployConfig(write(bad))).toThrow(/admin\.repo/);
  });

  it("reads the committed config", () => {
    const cfg = loadDeployConfig();
    expect(cfg.issuer).toBe("https://auth.mngroup.id");
    expect(cfg.auth.project).toBe("monexa-auth");
  });
});
