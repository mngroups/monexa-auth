import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** The `oidc-provider` adapter table: sessions, grants, codes, refresh tokens, interactions. */
export const oidcStore = pgTable(
  "oidc_store",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    grantId: text("grant_id"),
    uid: text("uid"),
    /** Denormalised for revocation when a user or org loses access. */
    userId: uuid("user_id"),
    orgId: uuid("org_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.id] }),
    index("oidc_store_kind_grant_id_idx").on(table.kind, table.grantId),
    index("oidc_store_kind_uid_idx").on(table.kind, table.uid),
    index("oidc_store_expires_at_idx").on(table.expiresAt),
    index("oidc_store_user_id_idx").on(table.userId),
    index("oidc_store_org_id_idx").on(table.orgId),
  ]
);
