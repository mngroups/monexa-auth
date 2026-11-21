import type { FastifyInstance } from "fastify";
import type Provider from "oidc-provider";

export const OIDC_PREFIX = "/oidc";

/**
 * Serves the provider under `/oidc/*`. The scope drops Fastify's body parsers (the provider
 * reads form bodies itself), hijacks the reply and hands the raw request to the provider,
 * with `originalUrl` keeping the prefix so the provider's absolute URLs include it.
 */
export async function mountProvider(app: FastifyInstance, provider: Provider): Promise<void> {
  const callback = provider.callback();
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => done(null));
    // Not a JSON API route: OAuth/OIDC wire format, so no Zod schemas and no envelope.
    scope.all(
      `${OIDC_PREFIX}/*`,
      { config: { public: true }, schema: { hide: true } },
      async (request, reply) => {
        reply.hijack();
        const raw = request.raw as typeof request.raw & { originalUrl?: string };
        raw.originalUrl = raw.url;
        raw.url = (raw.url as string).slice(OIDC_PREFIX.length);
        await callback(raw, reply.raw);
      }
    );
  });
}
