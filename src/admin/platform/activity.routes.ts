import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import * as service from "./activity.service.js";
import { isoDate, PLATFORM_PREFIX, pageOf, pageQuery, routeMeta } from "./common.js";

export const activitySchema = z.object({
  id: z.string(),
  at: isoDate,
  actorUserId: z.string().nullable(),
  orgId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

export async function activityRoutes(app: FastifyInstance, { db }: { db: Db }) {
  app.withTypeProvider<ZodTypeProvider>().get(
    `${PLATFORM_PREFIX}/activity`,
    {
      schema: {
        ...routeMeta,
        summary: "Full activity log, newest first; filter by org, action and time range",
        querystring: pageQuery.extend({
          orgId: z.uuid().optional(),
          action: z.string().min(1).max(100).optional(),
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        }),
        response: { 200: envelopeSchema(pageOf(activitySchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listActivity(db, request.query));
    }
  );
}
