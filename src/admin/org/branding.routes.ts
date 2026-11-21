import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import * as service from "../../branding/logo.service.js";
import { readLogoUpload } from "../../branding/upload.js";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { PERMISSIONS } from "../../permissions.js";
import { requireAdmin } from "../guard.js";
import { actorOf, isoDate, ORG_PREFIX, orgOf, routeMeta } from "./common.js";

export const logoSchema = z.object({ etag: z.string(), updatedAt: isoDate });

/** `/api/admin/org/logo`: the token's org's login logo (multipart field `file`). */
export async function brandingRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  app.addHook("onRequest", requireAdmin({ db, env }, PERMISSIONS.brandingManage));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.put(
    `${ORG_PREFIX}/logo`,
    {
      schema: {
        ...routeMeta,
        summary: "Upload or replace the org's login logo (PNG, JPEG or WebP, max 512 KB)",
        consumes: ["multipart/form-data"],
        response: { 200: envelopeSchema(logoSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.setLogo(db, actorOf(request), orgOf(request), await readLogoUpload(request))
      );
    }
  );

  r.delete(
    `${ORG_PREFIX}/logo`,
    {
      schema: {
        ...routeMeta,
        summary: "Remove the org's login logo",
        response: { 200: envelopeSchema(z.null()) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.removeLogo(db, actorOf(request), orgOf(request)));
    }
  );
}
