import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";

/** AES-256-GCM with a fresh 12-byte IV: base64 `iv.tag.ciphertext`. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(".");
}

/** Inverse of `encryptSecret`; throws on a wrong key, tampering or a malformed value. */
export function decryptSecret(enc: string, key: Buffer): string {
  const parts = enc.split(".");
  if (parts.length !== 3) throw new Error("malformed encrypted secret");
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64")) as [
    Buffer,
    Buffer,
    Buffer,
  ];
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
