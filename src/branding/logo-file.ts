export type LogoMime = "image/png" | "image/jpeg" | "image/webp";

/** 512 KB. */
export const LOGO_MAX_BYTES = 524_288;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * The image type from the file's own bytes. The upload's file name and MIME claim are never
 * trusted: only these three raster formats can be served without running script (no SVG).
 */
export function detectLogoMime(bytes: Uint8Array): LogoMime | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}
