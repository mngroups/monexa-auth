import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { readLogoUpload } from "../../branding/upload.js";
import type { Db } from "../../db/client.js";
import { logoSchema } from "../org/branding.routes.js";
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
  logo: logoSchema.nullable(),
});

const orgAppSchema = z.object({
  orgId: z.string(),
  appId: z.string(),
  enabled: z.boolean(),
  revokedGrants: z.number().int(),
});
const orgAppListItemSchema = z.object({
  appId: z.string(),
  clientId: z.string(),
  name: z.string(),
  isActive: z.boolean(),
  enabled: z.boolean(),
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

  r.get(
    `${base}/:id/apps`,
    {
      schema: {
        ...routeMeta,
        summary: "List every app with whether the org has it enabled",
        params: idParams,
        response: { 200: envelopeSchema(z.array(orgAppListItemSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listOrgApps(db, request.params.id));
    }
  );

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

  r.put(
    `${base}/:id/logo`,
    {
      schema: {
        ...routeMeta,
        summary: "Upload or replace an org's login logo (PNG, JPEG or WebP, max 512 KB)",
        consumes: ["multipart/form-data"],
        params: idParams,
        response: { 200: envelopeSchema(logoSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(
        await service.setOrgLogo(
          db,
          actorOf(request),
          request.params.id,
          await readLogoUpload(request)
        )
      );
    }
  );

  r.delete(
    `${base}/:id/logo`,
    {
      schema: {
        ...routeMeta,
        summary: "Remove an org's login logo",
        params: idParams,
        response: { 200: envelopeSchema(z.null()) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.removeOrgLogo(db, actorOf(request), request.params.id));
    }
  );
}
