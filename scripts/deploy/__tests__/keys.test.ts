import { generateKeys, KEY_NAMES, validateKeys } from "../keys.js";

describe("generateKeys", () => {
  it("produces the four keys and they pass validation", () => {
    const keys = generateKeys();
    expect(Object.keys(keys).sort()).toEqual([...KEY_NAMES].sort());
    expect(validateKeys(keys)).toEqual([]);
  });

  it("stores the signing key on one line with literal \\n, as the env loader expects", () => {
    const { OIDC_SIGNING_KEY } = generateKeys();
    expect(OIDC_SIGNING_KEY).not.toContain("\n");
    expect(OIDC_SIGNING_KEY).toContain("\\n");
    expect(OIDC_SIGNING_KEY.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
  });

  it("never repeats a key", () => {
    expect(generateKeys().CLIENT_SECRET_KEY).not.toBe(generateKeys().CLIENT_SECRET_KEY);
  });
});

describe("validateKeys", () => {
  it("names each bad key without echoing its value", () => {
    const problems = validateKeys({
      OIDC_SIGNING_KEY: "not-a-pem",
      OIDC_COOKIE_KEYS: "short",
      CLIENT_SECRET_KEY: Buffer.alloc(16).toString("base64"),
      CRON_SECRET: "tiny",
    });
    expect(problems).toEqual([
      "OIDC_SIGNING_KEY",
      "OIDC_COOKIE_KEYS",
      "CLIENT_SECRET_KEY",
      "CRON_SECRET",
    ]);
    expect(problems.join(" ")).not.toContain("not-a-pem");
  });
});
