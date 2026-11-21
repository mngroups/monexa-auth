import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import type { Env } from "../../env.js";
import { PERMISSIONS } from "../../permissions.js";
import { requireAdmin } from "../guard.js";
import {
  actorOf,
  ORG_PREFIX,
  orgOf,
  pageOf,
  pageQuery,
  routeMeta,
  userIdParams,
} from "./common.js";
import * as service from "./members.service.js";

export const memberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  username: z.string().nullable(),
  name: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  roles: z.array(z.object({ id: z.string(), name: z.string(), appId: z.string() })),
});

const temporaryPassword = z.string().max(128);

export async function memberRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  app.addHook("onRequest", requireAdmin({ db, env }, PERMISSIONS.memberManage));
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = `${ORG_PREFIX}/members`;
  const member = envelopeSchema(memberSchema);

  r.get(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "List/search the org's members with their roles",
        querystring: pageQuery.extend({ q: z.string().trim().min(1).optional() }),
        response: { 200: envelopeSchema(pageOf(memberSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listMembers(db, orgOf(request), request.query));
    }
  );

  r.post(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "Create a user with a temporary password and add them to the org",
        body: z.object({
          email: z.email().max(254),
          username: z
            .string()
            .min(3)
            .max(50)
            .regex(/^[A-Za-z0-9._-]+$/)
            .optional(),
          name: z.string().trim().min(1).max(120),
          temporaryPassword,
        }),
        response: { 200: member },
      },
    },
    async (request, reply) => {
      reply.ok(await service.createMember(db, actorOf(request), orgOf(request), request.body));
    }
  );

  r.post(
    `${base}/existing`,
    {
      schema: {
        ...routeMeta,
        summary: "Add an existing user to the org by email",
        body: z.object({ email: z.email().max(254) }),
        response: { 200: member },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.addExistingMember(db, actorOf(request), orgOf(request), request.body.email)
      );
    }
  );

  r.delete(
    `${base}/:userId`,
    {
      schema: {
        ...routeMeta,
        summary: "Remove a member from the org (and end their grants for it)",
        params: userIdParams,
        response: { 200: envelopeSchema(z.object({ userId: z.string() })) },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.removeMember(db, actorOf(request), orgOf(request), request.params.userId)
      );
    }
  );

  for (const [verb, isActive] of [
    ["activate", true],
    ["deactivate", false],
  ] as const) {
    r.post(
      `${base}/:userId/${verb}`,
      {
        schema: {
          ...routeMeta,
          summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} a membership`,
          params: userIdParams,
          response: { 200: member },
        },
      },
      async (request, reply) => {
        reply.ok(
          await service.setMemberActive(
            db,
            actorOf(request),
            orgOf(request),
            request.params.userId,
            isActive
          )
        );
      }
    );
  }

  r.post(
    `${base}/:userId/reset-password`,
    {
      schema: {
        ...routeMeta,
        summary: "Set a temporary password (only for users whose every membership is in this org)",
        params: userIdParams,
        body: z.object({ temporaryPassword }),
        response: { 200: member },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.resetMemberPassword(
          db,
          actorOf(request),
          orgOf(request),
          request.params.userId,
          request.body.temporaryPassword
        )
      );
    }
  );
}
