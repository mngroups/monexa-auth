import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { errors } from "oidc-provider";
import { z } from "zod";
import { resolveBrand } from "../../branding/resolve-brand.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { allowFormRedirect } from "./csp.js";
import { renderView } from "./render.js";
import {
  type Interaction,
  type InteractionDeps,
  type Outcome,
  showInteraction,
  submitInteraction,
} from "./service.js";

export const INTERACTION_PREFIX = "/interaction";

const params = z.object({ uid: z.string().min(1) });
const field = z.string().optional();
const form = z.object({
  uid: field,
  step: field,
  identifier: field,
  password: field,
  current_password: field,
  new_password: field,
  confirm_password: field,
  org_id: field,
});

class ForeignInteraction extends Error {}

/**
 * The interaction behind this request's cookie, which must be the one in the URL (and in the
 * form's `uid`): the provider binds the interaction to its cookie (SameSite=Lax, scoped to
 * `/interaction/<uid>`), so a form posted from elsewhere has no matching interaction.
 */
async function loadInteraction(
  deps: InteractionDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  uid: string,
  formUid?: string
): Promise<Interaction> {
  const interaction = await deps.provider.interactionDetails(request.raw, reply.raw);
  if (interaction.uid !== uid || (formUid !== undefined && formUid !== uid)) {
    throw new ForeignInteraction();
  }
  return interaction;
}

function sendHtml(reply: FastifyReply, status: number, html: string, formTarget?: string) {
  const csp = allowFormRedirect(reply.getHeader("content-security-policy") as string, formTarget);
  if (csp) reply.header("content-security-policy", csp);
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(html);
}

async function respond(
  deps: InteractionDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  interaction: Interaction,
  outcome: Outcome
) {
  if (outcome.kind === "render") {
    // The forms' redirect chain ends at the app's (validated) redirect_uri.
    const target = interaction.params.redirect_uri as string | undefined;
    const brand = await resolveBrand(deps.db, interaction.params.org_hint);
    return sendHtml(
      reply,
      outcome.status,
      renderView(outcome.view, { ...outcome.data, brand }),
      target
    );
  }
  reply.hijack();
  await deps.provider.interactionFinished(request.raw, reply.raw, outcome.result, {
    mergeWithLastSubmission: false,
  });
}

/** An expired or foreign interaction is a 400 page, never a provider stack trace. */
async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ForeignInteraction || error instanceof errors.SessionNotFound) {
      return sendHtml(
        reply,
        400,
        renderView("error", { message: MESSAGES_AUTH.interactionNotFound })
      );
    }
    throw error;
  }
}

/**
 * `/interaction/:uid`: the login, change-password and org-picker pages the provider sends the
 * browser to. Normal Fastify routes (global per-IP rate limit), HTML instead of the envelope.
 */
export async function interactionRoutes(app: FastifyInstance, deps: InteractionDeps) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );
  const r = app.withTypeProvider<ZodTypeProvider>();
  const audit = (request: FastifyRequest) => ({
    ip: request.ip,
    userAgent: request.headers["user-agent"] || undefined,
  });

  // Not JSON API routes: browser pages, so no response schemas and no envelope.
  r.get(`${INTERACTION_PREFIX}/:uid`, { schema: { hide: true, params } }, (request, reply) =>
    guarded(reply, async () => {
      const interaction = await loadInteraction(deps, request, reply, request.params.uid);
      const outcome = await showInteraction(deps, interaction, audit(request));
      await respond(deps, request, reply, interaction, outcome);
    })
  );

  r.post(
    `${INTERACTION_PREFIX}/:uid`,
    { schema: { hide: true, params, body: form } },
    (request, reply) =>
      guarded(reply, async () => {
        const interaction = await loadInteraction(
          deps,
          request,
          reply,
          request.params.uid,
          request.body.uid ?? ""
        );
        const outcome = await submitInteraction(deps, interaction, request.body, audit(request));
        await respond(deps, request, reply, interaction, outcome);
      })
  );
}
