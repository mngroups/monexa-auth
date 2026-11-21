import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { PERMISSIONS } from "../../permissions.js";
import { requireAdmin } from "../guard.js";
import { actorOf, ORG_PREFIX, orgOf, routeMeta, userIdParams } from "./common.js";
import { memberSchema } from "./members.routes.js";
import * as service from "./roles.service.js";

export async function memberRoleRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  app.addHook("onRequest", requireAdmin({ db, env }, PERMISSIONS.roleAssign));
  app.withTypeProvider<ZodTypeProvider>().put(
    `${ORG_PREFIX}/members/:userId/roles`,
    {
      schema: {
        ...routeMeta,
        summary:
          "Set a member's roles (replaces them); each role's app must be enabled for the org",
        params: userIdParams,
        body: z.object({ roleIds: z.array(z.uuid()).max(100) }),
        response: { 200: envelopeSchema(memberSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.setMemberRoles(
          db,
          actorOf(request),
          orgOf(request),
          request.params.userId,
          request.body.roleIds
        )
      );
    }
  );
}
