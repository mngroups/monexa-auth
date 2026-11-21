import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { actorOf, idParams, PLATFORM_PREFIX, routeMeta } from "./common.js";
import * as service from "./permissions.service.js";

/** `group[.resource[.sub]]:action` */
export const permissionString = z
  .string()
  .max(120)
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*:[a-z][a-z0-9_-]*$/);

const permissionSchema = z.object({ permission: z.string(), description: z.string() });

export async function permissionRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = `${PLATFORM_PREFIX}/apps/:id/permissions`;

  r.get(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "List an app's permission catalog",
        params: idParams,
        response: { 200: envelopeSchema(z.array(permissionSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listPermissions(db, request.params.id));
    }
  );

  r.post(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "Add a permission to an app's catalog",
        params: idParams,
        body: z.object({
          permission: permissionString,
          description: z.string().trim().max(300).default(""),
        }),
        response: { 200: envelopeSchema(permissionSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.addPermission(db, env, actorOf(request), request.params.id, request.body)
      );
    }
  );

  r.delete(
    `${base}/:permission`,
    {
      schema: {
        ...routeMeta,
        summary: "Remove a permission from the catalog (and from the app's roles)",
        params: z.object({ id: z.uuid(), permission: permissionString }),
        response: { 200: envelopeSchema(z.object({ permission: z.string() })) },
      },
    },
    async (request, reply) => {
      const { id, permission } = request.params;
      reply.ok(await service.removePermission(db, actorOf(request), id, permission));
    }
  );
}
