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

// Views of different features share one layout, so templates resolve from the source root
// (`src/` or `dist/`): `oidc/interactions/views/layout.eta` and `<feature>/views/<name>.eta`.
const root = fileURLToPath(new URL("../../", import.meta.url));
const eta = new Eta({ views: root, cache: true });

/**
 * A renderer for one `views` directory (relative to the source root). Templates are read from
 * disk once and cached; output is HTML-escaped unless `<%~`; every view gets the Indonesian
 * copy as `it.m`.
 */
export function createRenderer<N extends string>(viewsDir: string) {
  return (name: N, data: Record<string, unknown> = {}): string =>
    eta.render(`./${viewsDir}/${name}`, { ...data, m: MESSAGES_AUTH });
}

/** Renders a sign-in page. */
export const renderView = createRenderer<ViewName>("oidc/interactions/views");
