import { fileURLToPath } from "node:url";
import { Eta } from "eta";
import { MESSAGES_AUTH } from "../../messages.js";

export type ViewName =
  | "login"
  | "select-org"
  | "change-password"
  | "error"
  | "logout"
  | "logged-out";

// Templates are read from disk once and cached; output is HTML-escaped unless `<%~`.
const eta = new Eta({
  views: fileURLToPath(new URL("./views", import.meta.url)),
  cache: true,
});

/** Renders a sign-in page; every view gets the Indonesian copy as `it.m`. */
export function renderView(name: ViewName, data: Record<string, unknown> = {}): string {
  return eta.render(`./${name}`, { ...data, m: MESSAGES_AUTH });
}
