import { z } from "zod";

/** `default` is the logo for light backgrounds, `dark` the white/light one for dark backgrounds. */
export const logoVariantSchema = z.enum(["default", "dark"]);
/** Querystring of the admin logo routes; a missing variant means `default`. */
export const logoVariantQuery = z.object({ variant: logoVariantSchema.default("default") });
