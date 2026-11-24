import { createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";

export const KEY_NAMES = [
  "OIDC_SIGNING_KEY",
  "OIDC_COOKIE_KEYS",
  "CLIENT_SECRET_KEY",
  "CRON_SECRET",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];

/**
 * The four permanent secrets of monexa-auth. The signing key is a PKCS#8 PEM on one line
 * with literal `\n`, the form `src/env.ts` reads. Values must never be printed.
 */
export function generateKeys(): Record<KeyName, string> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    OIDC_SIGNING_KEY: pem.replace(/\n/g, "\\n"),
    OIDC_COOKIE_KEYS: randomBytes(32).toString("base64"),
    CLIENT_SECRET_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: randomBytes(32).toString("hex"),
  };
}

function isRsa2048(pem: string): boolean {
  try {
    const key = createPrivateKey(pem.replace(/\\n/g, "\n"));
    return key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails?.modulusLength === 2048;
  } catch {
    return false;
  }
}

/** Names of the keys that are unusable; never their values. */
export function validateKeys(keys: Record<KeyName, string>): KeyName[] {
  const ok: Record<KeyName, boolean> = {
    OIDC_SIGNING_KEY: isRsa2048(keys.OIDC_SIGNING_KEY),
    OIDC_COOKIE_KEYS: keys.OIDC_COOKIE_KEYS.length >= 32,
    CLIENT_SECRET_KEY: Buffer.from(keys.CLIENT_SECRET_KEY, "base64").length === 32,
    CRON_SECRET: keys.CRON_SECRET.length >= 16,
  };
  return KEY_NAMES.filter((name) => !ok[name]);
}
