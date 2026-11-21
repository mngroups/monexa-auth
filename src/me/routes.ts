import { AppError, envelopeSchema, MESSAGES } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { listMyOrgs } from "./service.js";

const orgSchema = z.object({ id: z.string(), name: z.string() });

function bearerToken(header: string | undefined): string {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  if (!match?.[1]) throw new AppError(401, MESSAGES.invalidToken);
  return match[1];
}

/** `/api/me/*`: the signed-in user's own data, authenticated by this service's own tokens. */
export async function meRoutes(app: FastifyInstance, { db, env }: { db: Db; env: Env }) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/me/orgs",
    {
      schema: {
        tags: ["me"],
        summary: "Orgs the user can switch to in the token's app",
        security: [{ bearerAuth: [] }],
        response: { 200: envelopeSchema(z.array(orgSchema)) },
      },
    },
    async (request, reply) => {
      reply.ok(await listMyOrgs(db, env, bearerToken(request.headers.authorization)));
    }
  );
}
