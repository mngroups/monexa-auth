import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import {
  actorOf,
  idParams,
  isoDate,
  PLATFORM_PREFIX,
  pageOf,
  pageQuery,
  routeMeta,
} from "./common.js";
import * as service from "./orgs.service.js";

const slug = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const name = z.string().trim().min(1).max(120);

export const orgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const orgAppSchema = z.object({
  orgId: z.string(),
  appId: z.string(),
  enabled: z.boolean(),
  revokedGrants: z.number().int(),
});
const orgAppParams = z.object({ id: z.uuid(), appId: z.uuid() });

export async function orgRoutes(app: FastifyInstance, { db }: { db: Db }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = `${PLATFORM_PREFIX}/orgs`;

  r.get(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "List/search orgs",
        querystring: pageQuery.extend({ q: z.string().trim().min(1).optional() }),
        response: { 200: envelopeSchema(pageOf(orgSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listOrgs(db, request.query));
    }
  );

  r.post(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "Create an org",
        body: z.object({ slug, name }),
        response: { 200: envelopeSchema(orgSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.createOrg(db, actorOf(request), request.body));
    }
  );

  r.patch(
    `${base}/:id`,
    {
      schema: {
        ...routeMeta,
        summary: "Update an org",
        params: idParams,
        body: z
          .object({ slug: slug.optional(), name: name.optional() })
          .refine((v) => Object.keys(v).length > 0),
        response: { 200: envelopeSchema(orgSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.updateOrg(db, actorOf(request), request.params.id, request.body));
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
          summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} an org`,
          params: idParams,
          response: { 200: envelopeSchema(orgSchema) },
        },
      },
      async (request, reply) => {
        reply.ok(await service.setOrgActive(db, actorOf(request), request.params.id, isActive));
      }
    );
  }

  r.put(
    `${base}/:id/apps/:appId`,
    {
      schema: {
        ...routeMeta,
        summary: "Enable an app for an org",
        params: orgAppParams,
        response: { 200: envelopeSchema(orgAppSchema) },
      },
    },
    async (request, reply) => {
      const { id, appId } = request.params;
      reply.ok(await service.enableOrgApp(db, actorOf(request), id, appId));
    }
  );

  r.delete(
    `${base}/:id/apps/:appId`,
    {
      schema: {
        ...routeMeta,
        summary: "Disable an app for an org (revokes its grants)",
        params: orgAppParams,
        response: { 200: envelopeSchema(orgAppSchema) },
      },
    },
    async (request, reply) => {
      const { id, appId } = request.params;
      reply.ok(await service.disableOrgApp(db, actorOf(request), id, appId));
    }
  );
}
