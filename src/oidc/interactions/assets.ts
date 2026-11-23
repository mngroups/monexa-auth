import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

/** Static files of the sign-in pages, from `public-assets/` at the repo root. */
const ASSETS: Record<string, string> = {
  "monexa-theme.css": "text/css; charset=utf-8",
  "auto-submit.js": "text/javascript; charset=utf-8",
};

const dir = new URL("../../../public-assets/", import.meta.url);

// Read once at load: immutable files of this release, each with a short content hash.
const files = new Map(
  Object.entries(ASSETS).map(([name, type]) => {
    const body = readFileSync(new URL(name, dir));
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
    return [name, { type, body, hash }];
  })
);

/** `/assets/<name>?v=<hash>`: the URL that changes whenever the file's content does. */
export function assetUrl(name: string): string {
  const file = files.get(name);
  if (!file) throw new Error(`unknown asset: ${name}`);
  return `/assets/${name}?v=${file.hash}`;
}

/** Every asset's versioned URL, by file name. */
export function assetUrls(): Record<string, string> {
  return Object.fromEntries([...files.keys()].map((name) => [name, assetUrl(name)]));
}

/** Serves `/assets/<file>` for the allow-listed files. */
export async function interactionAssets(app: FastifyInstance): Promise<void> {
  // Not a JSON API route: static files, so no Zod schemas and no envelope.
  app.get<{ Params: { file: string }; Querystring: { v?: string } }>(
    "/assets/:file",
    { schema: { hide: true } },
    async (request, reply) => {
      const file = files.get(request.params.file);
      if (!file) return reply.callNotFound();
      const cache =
        request.query.v === file.hash
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600";
      return reply.type(file.type).header("cache-control", cache).send(file.body);
    }
  );
}
