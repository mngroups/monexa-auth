import { envelopeSchema } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { APP_GRANTS } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import * as service from "./apps.service.js";
import {
  actorOf,
  idParams,
  isoDate,
  PLATFORM_PREFIX,
  pageOf,
  pageQuery,
  routeMeta,
} from "./common.js";

const uris = z.array(z.url({ protocol: /^https?$/ })).max(50);

export const appSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  postLogoutRedirectUris: z.array(z.string()),
  allowedGrants: z.array(z.enum(APP_GRANTS)),
  accessTtlSeconds: z.number().int(),
  refreshTtlSeconds: z.number().int(),
  isActive: z.boolean(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

const fields = {
  name: z.string().trim().min(1).max(120),
  redirectUris: uris,
  postLogoutRedirectUris: uris,
  allowedGrants: z.array(z.enum(APP_GRANTS)).min(1),
  accessTtlSeconds: z.number().int().min(60).max(86_400),
  refreshTtlSeconds: z.number().int().min(300).max(31_536_000),
};

export async function appRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const base = `${PLATFORM_PREFIX}/apps`;

  r.get(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "List/search apps",
        querystring: pageQuery.extend({ q: z.string().trim().min(1).optional() }),
        response: { 200: envelopeSchema(pageOf(appSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.listApps(db, request.query));
    }
  );

  r.get(
    `${base}/:id`,
    {
      schema: {
        ...routeMeta,
        summary: "Get an app (never its secret)",
        params: idParams,
        response: { 200: envelopeSchema(appSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.getApp(db, request.params.id));
    }
  );

  r.post(
    base,
    {
      schema: {
        ...routeMeta,
        summary: "Create an app; the plaintext clientSecret is returned only here",
        body: z.object({
          clientId: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,62}$/),
          name: fields.name,
          redirectUris: fields.redirectUris.default([]),
          postLogoutRedirectUris: fields.postLogoutRedirectUris.default([]),
          allowedGrants: fields.allowedGrants.default(["authorization_code"]),
          accessTtlSeconds: fields.accessTtlSeconds.default(600),
          refreshTtlSeconds: fields.refreshTtlSeconds.default(604_800),
        }),
        response: { 200: envelopeSchema(appSchema.extend({ clientSecret: z.string() })) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.createApp(db, env, actorOf(request), request.body));
    }
  );

  r.patch(
    `${base}/:id`,
    {
      schema: {
        ...routeMeta,
        summary: "Update an app",
        params: idParams,
        body: z
          .object({
            name: fields.name.optional(),
            redirectUris: fields.redirectUris.optional(),
            postLogoutRedirectUris: fields.postLogoutRedirectUris.optional(),
            allowedGrants: fields.allowedGrants.optional(),
            accessTtlSeconds: fields.accessTtlSeconds.optional(),
            refreshTtlSeconds: fields.refreshTtlSeconds.optional(),
          })
          .refine((v) => Object.keys(v).length > 0),
        response: { 200: envelopeSchema(appSchema) },
      },
    },
    async (request, reply) => {
      reply.ok(await service.updateApp(db, actorOf(request), request.params.id, request.body));
    }
  );

  r.post(
    `${base}/:id/rotate-secret`,
    {
      schema: {
        ...routeMeta,
        summary: "Rotate the client secret; the new plaintext is returned only here",
        params: idParams,
        response: {
          200: envelopeSchema(
            z.object({ id: z.string(), clientId: z.string(), clientSecret: z.string() })
          ),
        },
      },
    },
    async (request, reply) => {
      reply.ok(await service.rotateSecret(db, env, actorOf(request), request.params.id));
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
          summary: `${verb[0]?.toUpperCase()}${verb.slice(1)} an app`,
          params: idParams,
          response: { 200: envelopeSchema(appSchema) },
        },
      },
      async (request, reply) => {
        reply.ok(
          await service.setAppActive(db, env, actorOf(request), request.params.id, isActive)
        );
      }
    );
  }
}
