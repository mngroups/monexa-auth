import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "@mono/server-kit";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Db } from "../db/client.js";
import type { Env } from "../env.js";
import { MESSAGES_AUTH } from "../messages.js";
import { createRenderer } from "../oidc/interactions/render.js";
import { changePassword } from "./service.js";

export const ACCOUNT_PASSWORD_PATH = "/account/password";
const CSRF_COOKIE = "monexa_csrf";

const render = createRenderer<"password" | "error">("account/views");

const field = z.string().optional();
const form = z.object({
  csrf: field,
  identifier: field,
  current_password: field,
  new_password: field,
  confirm_password: field,
});

function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function sameToken(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function sendHtml(reply: FastifyReply, status: number, html: string) {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(html);
}

/**
 * `/account/password`: change a password without any app session (e.g. replacing an
 * admin-issued temporary one). Browser pages, so HTML instead of the envelope. The form
 * posts to itself and never redirects, so helmet's `form-action 'self'` stays as is.
 */
export async function accountRoutes(app: FastifyInstance, deps: { db: Db; env: Env }) {
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string)))
  );
  // Errors (the 429 from the rate limit included) are pages here; others go to the kit's handler.
  const parentHandler = app.errorHandler;
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError && error.code === 429) {
      return sendHtml(reply, 429, render("error", { message: error.message }));
    }
    return parentHandler(error, request, reply);
  });

  const r = app.withTypeProvider<ZodTypeProvider>();
  // Not JSON API routes: no response schemas and no envelope.
  r.get(ACCOUNT_PASSWORD_PATH, { schema: { hide: true } }, (_request, reply) => {
    // Double-submit CSRF: the same random value in a strict cookie and in the form.
    const csrf = randomBytes(32).toString("base64url");
    const secure = deps.env.NODE_ENV === "production" ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${CSRF_COOKIE}=${csrf}; Path=/account; HttpOnly; SameSite=Strict${secure}`
    );
    return sendHtml(reply, 200, render("password", { csrf }));
  });

  r.post(ACCOUNT_PASSWORD_PATH, { schema: { hide: true, body: form } }, async (request, reply) => {
    const csrf = request.body.csrf;
    if (!sameToken(readCookie(request, CSRF_COOKIE), csrf)) {
      return sendHtml(reply, 403, render("error", { message: MESSAGES_AUTH.csrfInvalid }));
    }
    const result = await changePassword(deps, request.body, {
      ip: request.ip,
      userAgent: request.headers["user-agent"] || undefined,
    });
    if (result.ok) return sendHtml(reply, 200, render("password", { done: true }));
    return sendHtml(
      reply,
      result.status,
      render("password", { csrf, identifier: request.body.identifier, error: result.error })
    );
  });
}
