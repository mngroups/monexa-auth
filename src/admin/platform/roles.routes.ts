import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { actorOf, idParams, isoDate, PLATFORM_PREFIX, routeMeta } from "./common.js";
import * as service from "./roles.service.js";

const roleSchema = z.object({
  id: z.string(),
  appId: z.string(),
  name: z.string(),
  description: z.string(),
  permissions: z.array(z.string()),
  createdAt: isoDate,
});
const name = z.string().trim().min(1).max(80);
const description = z.string().trim().max(300);
const permissions = z.array(z.string().min(1).max(120)).max(500);
const roleParams = z.object({ id: z.uuid(), roleId: z.uuid() });

export async function roleRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = `${PLATFORM_PREFIX}/apps/:id/roles`;

  r.get(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "List an app's roles with their permissions",
        params: idParams,
        response: { 200: envelopeSchema(z.array(roleSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listRoles(db, request.params.id));
    }
  );

  r.post(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "Create a role",
        params: idParams,
        body: z.object({
          name,
          description: description.default(""),
          permissions: permissions.default([]),
        }),
        response: { 200: envelopeSchema(roleSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.createRole(db, actorOf(request), request.params.id, request.body));
    }
  );

  r.patch(
    `${base}/:roleId`,
    {
      schema: {
        ...routeMeta,
        summary: "Rename/describe a role",
        params: roleParams,
        body: z
          .object({ name: name.optional(), description: description.optional() })
          .refine((v) => Object.keys(v).length > 0),
        response: { 200: envelopeSchema(roleSchema) },
      },
    },
    async (request, reply) => {
      const { id, roleId } = request.params;
      reply.ok(await service.updateRole(db, actorOf(request), id, roleId, request.body));
    }
  );

  r.put(
    `${base}/:roleId/permissions`,
    {
      schema: {
        ...routeMeta,
        summary: "Replace a role's permissions (each must be in the app's catalog)",
        params: roleParams,
        body: z.object({ permissions }),
        response: { 200: envelopeSchema(roleSchema) },
      },
    },
    async (request, reply) => {
      const { id, roleId } = request.params;
      reply.ok(
        await service.setRolePermissions(db, actorOf(request), id, roleId, request.body.permissions)
      );
    }
  );

  r.delete(
    `${base}/:roleId`,
    {
      schema: {
        ...routeMeta,
        summary: "Delete a role",
        params: roleParams,
        response: { 200: envelopeSchema(z.object({ id: z.string() })) },
      },
    },
    async (request, reply) => {
      const { id, roleId } = request.params;
      reply.ok(await service.deleteRole(db, actorOf(request), id, roleId));
    }
  );
}
