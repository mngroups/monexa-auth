import type { FastifyRequest } from "fastify";
import type { LogoUpload } from "./logo.service.js";

/** The single `file` part of a multipart request; undefined when there is none. */
export async function readLogoUpload(request: FastifyRequest): Promise<LogoUpload | undefined> {
  if (!request.isMultipart()) return undefined;
  const part = await request.file();
  if (!part) return undefined;
  const content = await part.toBuffer();
  // With throwFileSizeLimit off, an oversized part arrives cut at the limit and flagged.
  return { content, truncated: part.file.truncated };
}
