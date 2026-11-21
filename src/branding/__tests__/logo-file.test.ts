import { describe, expect, it } from "vitest";
import { detectLogoMime, LOGO_MAX_BYTES } from "../logo-file.js";
import { JPEG, PNG, SVG, WEBP } from "./files.js";

describe("detectLogoMime", () => {
  it("recognizes PNG, JPEG and WebP by their bytes", () => {
    expect(detectLogoMime(PNG)).toBe("image/png");
    expect(detectLogoMime(JPEG)).toBe("image/jpeg");
    expect(detectLogoMime(WEBP)).toBe("image/webp");
  });

  it("refuses everything else, whatever it claims to be", () => {
    expect(detectLogoMime(SVG)).toBeNull();
    expect(detectLogoMime(Buffer.from("<!DOCTYPE html><html></html>"))).toBeNull();
    expect(detectLogoMime(Buffer.from("GIF89a......"))).toBeNull();
    expect(detectLogoMime(Buffer.from("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(detectLogoMime(Buffer.alloc(0))).toBeNull();
  });

  it("caps logos at 512 KB", () => {
    expect(LOGO_MAX_BYTES).toBe(524_288);
  });
});
