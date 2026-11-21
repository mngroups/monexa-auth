import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import {
  actorOf,
  idParams,
  isoDate,
  PLATFORM_PREFIX,
  pageOf,
  pageQuery,
  routeMeta,
} from "./common.js";
import * as service from "./platform-admins.service.js";

const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  isActive: z.boolean(),
  isPlatformAdmin: z.boolean(),
  mustChangePassword: z.boolean(),
  createdAt: isoDate,
});

export async function platformAdminRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = `${PLATFORM_PREFIX}/users`;

  r.get(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "List/search users",
        querystring: pageQuery.extend({ q: z.string().trim().min(1).optional() }),
        response: { 200: envelopeSchema(pageOf(userSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listUsers(db, request.query));
    }
  );

  r.post(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "Create a user with a temporary password (must change at first sign-in)",
        body: z.object({
          email: z.email().max(254),
          username: z
            .string()
            .min(3)
            .max(50)
            .regex(/^[A-Za-z0-9._-]+$/)
            .optional(),
          name: z.string().trim().min(1).max(120),
          temporaryPassword: z.string().max(128),
        }),
        response: { 200: envelopeSchema(userSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.createUser(db, actorOf(request), request.body));
    }
  );

  r.put(
    `${base}/:id/platform-admin`,
    {
      schema: {
        ...routeMeta,
        summary: "Grant platform admin",
        params: idParams,
        response: { 200: envelopeSchema(userSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.grantPlatformAdmin(db, actorOf(request), request.params.id));
    }
  );

  r.delete(
    `${base}/:id/platform-admin`,
    {
      schema: {
        ...routeMeta,
        summary: "Revoke platform admin",
        params: idParams,
        response: { 200: envelopeSchema(userSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.revokePlatformAdmin(db, env, actorOf(request), request.params.id));
    }
  );

  for (const [verb, isActive] of [
    ["activate", true],
    ["deactivate", false],
  ] as const) {
    r.post(
      `${base}/:id/${verb}`,
      {
        schema: {
          ...routeMeta,
          summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} a user`,
          params: idParams,
          response: { 200: envelopeSchema(userSchema) },
        },
      },
      async (request, reply) => {
        reply.ok(await service.setUserActive(db, actorOf(request), request.params.id, isActive));
      }
    );
  }
}
