import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { findLogoBySlug } from "./logo.repository.js";

export const LOGO_PATH = (slug: string) => `/branding/orgs/${encodeURIComponent(slug)}/logo`;

/**
 * `GET /branding/orgs/:slug/logo`: an org's login logo, public and cached. Shown cross-origin
 * by every app's login page, so it overrides helmet's same-origin CORP; it never runs script
 * (raster only, nosniff, a deny-all CSP).
 */
export async function brandingPublicRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/branding/orgs/:slug/logo",
    {
      schema: { hide: true, params: z.object({ slug: z.string().min(1).max(100) }) },
    },
    async (request, reply) => {
      const logo = await findLogoBySlug(db, request.params.slug);
      if (!logo) return reply.code(404).type("text/plain").send("Not found");
      const etag = `"${logo.etag}"`;
      reply
        .header("etag", etag)
        .header("cache-control", "public, max-age=300")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'")
        .header("cross-origin-resource-policy", "cross-origin");
      if (request.headers["if-none-match"] === etag) return reply.code(304).send();
      return reply.type(logo.mime).send(logo.content);
    }
  );
}
