import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const APP_GRANTS = ["password", "authorization_code"] as const;
export type AppGrant = (typeof APP_GRANTS)[number];

export const apps = pgTable(
  "apps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: text("client_id").notNull().unique(),
    name: text("name").notNull(),
    /** AES-256-GCM ciphertext (see CLIENT_SECRET_KEY); never returned after creation. */
    clientSecretEnc: text("client_secret_enc").notNull(),
    redirectUris: text("redirect_uris").array().notNull().default(sql`'{}'::text[]`),
    postLogoutRedirectUris: text("post_logout_redirect_uris")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    allowedGrants: text("allowed_grants")
      .array()
      .$type<AppGrant[]>()
      .notNull()
      .default(sql`'{authorization_code}'::text[]`),
    accessTtlSeconds: integer("access_ttl_seconds").notNull().default(600),
    refreshTtlSeconds: integer("refresh_ttl_seconds").notNull().default(604800),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "apps_allowed_grants_check",
      sql`${table.allowedGrants} <@ ARRAY['password', 'authorization_code']::text[]`
    ),
  ]
);

export type AppRow = typeof apps.$inferSelect;
