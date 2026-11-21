import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "../secrets.js";

const key = randomBytes(32);

describe("client secret encryption", () => {
  it("round-trips through base64 iv.tag.ciphertext", () => {
    const enc = encryptSecret("s3cret-value", key);
    expect(enc.split(".")).toHaveLength(3);
    expect(enc).not.toContain("s3cret-value");
    expect(decryptSecret(enc, key)).toBe("s3cret-value");
    // A fresh IV per call.
    expect(encryptSecret("s3cret-value", key)).not.toBe(enc);
  });

  it("throws when the ciphertext is tampered with", () => {
    const [iv, tag, ct] = encryptSecret("s3cret-value", key).split(".") as [string, string, string];
    const bytes = Buffer.from(ct, "base64");
    bytes[0] = (bytes[0] as number) ^ 0xff;
    expect(() => decryptSecret(`${iv}.${tag}.${bytes.toString("base64")}`, key)).toThrow();
  });

  it("throws with the wrong key or a malformed value", () => {
    const enc = encryptSecret("s3cret-value", key);
    expect(() => decryptSecret(enc, randomBytes(32))).toThrow();
    expect(() => decryptSecret("not-a-secret", key)).toThrow("malformed");
  });
});
