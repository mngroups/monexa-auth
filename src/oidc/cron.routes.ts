import { timingSafeEqual } from "node:crypto";
import { AppError, envelopeSchema, MESSAGES } from "@mono/server-kit";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { cleanupExpired } from "./cleanup.js";

/** Constant-time check of `Authorization: Bearer <secret>`. */
function hasBearer(header: string | undefined, secret: string): boolean {
  const given = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * `GET /api/cron/cleanup`: Vercel Cron's way to run the expired-row cleanup (Vercel calls it
 * with `Authorization: Bearer $CRON_SECRET`). Mounted only when CRON_SECRET is set; Docker
 * runs `node dist/cli/cleanup.js` from cron instead. Not for request-time use.
 */
export async function cronRoutes(app: FastifyInstance, opts: { db: Db; secret: string }) {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/cron/cleanup",
    {
      schema: {
        hide: true,
        headers: z.object({ authorization: z.string().optional() }),
        response: { 200: envelopeSchema(z.object({ deleted: z.number().int() })) },
      },
    },
    async (request, reply) => {
      if (!hasBearer(request.headers.authorization, opts.secret)) {
        throw new AppError(401, MESSAGES.invalidToken);
      }
      reply.ok({ deleted: await cleanupExpired(opts.db) });
    }
  );
}
