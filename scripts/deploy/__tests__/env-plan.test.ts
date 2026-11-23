import { loadDeployConfig } from "../config.js";
import { type Desired, desiredEnv, planEnv } from "../env-plan.js";

const cfg = loadDeployConfig();

describe("desiredEnv", () => {
  it("keeps the keys readable and the tokens secret", () => {
    const { auth, admin } = desiredEnv(cfg);
    const type = (list: Desired[], key: string) => list.find((d) => d.key === key)?.type;
    expect(type(auth, "CLIENT_SECRET_KEY")).toBe("plain");
    expect(type(auth, "OIDC_SIGNING_KEY")).toBe("plain");
    expect(type(auth, "GITLAB_NPM_TOKEN")).toBe("sensitive");
    expect(type(admin, "GITLAB_NPM_TOKEN")).toBe("sensitive");
    expect(auth.find((d) => d.key === "CLIENT_SECRET_KEY")?.onlyIfMissing).toBe(true);
  });

  it("wires both projects to the configured domains", () => {
    const { auth, admin } = desiredEnv(cfg);
    const value = (list: Desired[], key: string) => list.find((d) => d.key === key)?.value;
    expect(value(auth, "OIDC_ISSUER")).toBe("https://auth.mngroup.id");
    expect(value(auth, "ADMIN_REDIRECT_URIS")).toBe("https://auth-admin.mngroup.id/auth/callback");
    expect(value(admin, "API_BASE_URL")).toBe("https://auth.mngroup.id");
    expect(value(admin, "AUTH_MODE")).toBe("sso");
  });

  it("leaves the Neon-provided database URLs and the admin secret to their owners", () => {
    const keys = desiredEnv(cfg).auth.map((d) => d.key);
    expect(keys).not.toContain("DATABASE_URL");
    expect(keys).not.toContain("DATABASE_URL_UNPOOLED");
    expect(keys).not.toContain("ADMIN_CLIENT_SECRET");
  });
});

describe("planEnv", () => {
  const desired: Desired[] = [
    { key: "OIDC_ISSUER", type: "plain", value: "https://auth.example.id" },
    { key: "CLIENT_SECRET_KEY", type: "plain", onlyIfMissing: true },
    { key: "GITLAB_NPM_TOKEN", type: "sensitive", fromUser: true },
  ];

  it("adds what is missing and asks the user for their own secrets", () => {
    expect(planEnv([], desired)).toEqual([
      { kind: "add", desired: desired[0] },
      { kind: "add", desired: desired[1] },
      { kind: "askUser", desired: desired[2] },
    ]);
  });

  it("never regenerates an existing key and syncs plain config", () => {
    const existing = [
      { key: "OIDC_ISSUER", type: "encrypted" },
      { key: "CLIENT_SECRET_KEY", type: "plain" },
      { key: "GITLAB_NPM_TOKEN", type: "sensitive" },
    ];
    expect(planEnv(existing, desired).map((a) => a.kind)).toEqual(["sync", "skip", "skip"]);
  });

  it("leaves config alone when its value already matches", () => {
    const existing = [{ key: "OIDC_ISSUER", type: "encrypted", value: "https://auth.example.id" }];
    expect(planEnv(existing, desired)[0].kind).toBe("skip");
    const stale = [{ key: "OIDC_ISSUER", type: "encrypted", value: "https://old.example.id" }];
    expect(planEnv(stale, desired)[0].kind).toBe("sync");
  });

  it("flags a key stored with the wrong type instead of deleting it", () => {
    const existing = [{ key: "CLIENT_SECRET_KEY", type: "sensitive" }];
    expect(planEnv(existing, desired)[1]).toEqual({
      kind: "wrongType",
      desired: desired[1],
      actual: "sensitive",
    });
  });

  it("ignores variables it does not manage", () => {
    const existing = [{ key: "DATABASE_URL", type: "encrypted" }];
    expect(planEnv(existing, desired)).toHaveLength(3);
  });
});
