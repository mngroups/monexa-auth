import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

/** Static files of the sign-in pages, from `public-assets/` at the repo root. */
const ASSETS: Record<string, string> = {
  "monexa-theme.css": "text/css; charset=utf-8",
  "auto-submit.js": "text/javascript; charset=utf-8",
};

const dir = new URL("../../../public-assets/", import.meta.url);

/** Serves `/assets/<file>` for the allow-listed files (read once at registration). */
export async function interactionAssets(app: FastifyInstance): Promise<void> {
  const files = new Map(
    Object.entries(ASSETS).map(([name, type]) => [
      name,
      { type, body: readFileSync(new URL(name, dir)) },
    ])
  );
  // Not a JSON API route: static files, so no Zod schemas and no envelope.
  app.get<{ Params: { file: string } }>(
    "/assets/:file",
    { schema: { hide: true } },
    async (request, reply) => {
      const file = files.get(request.params.file);
      if (!file) return reply.callNotFound();
      return reply.type(file.type).header("cache-control", "public, max-age=3600").send(file.body);
    }
  );
}
