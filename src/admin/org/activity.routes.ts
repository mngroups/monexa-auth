import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { PERMISSIONS } from "../../permissions.js";
import { requireAdmin } from "../guard.js";
import { activitySchema } from "../platform/activity.routes.js";
import * as service from "./activity.service.js";
import { ORG_PREFIX, orgOf, pageOf, pageQuery, routeMeta } from "./common.js";

export async function activityRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  app.addHook("onRequest", requireAdmin({ db, env }, PERMISSIONS.activityView));
  app.withTypeProvider<ZodTypeProvider>().get(
    `${ORG_PREFIX}/activity`,
    {
      schema: {
        ...routeMeta,
        summary: "The org's activity log, newest first; filter by action and time range",
        querystring: pageQuery.extend({
          action: z.string().min(1).max(100).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
        response: { 200: envelopeSchema(pageOf(activitySchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listOrgActivity(db, orgOf(request), request.query));
    }
  );
}
