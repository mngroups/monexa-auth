import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Audit trail. `metadata` never holds a password, hash, token, client secret or code. */
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: uuid("actor_user_id"),
    orgId: uuid("org_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (table) => [
    index("activity_log_at_idx").on(table.at.desc()),
    index("activity_log_org_at_idx").on(table.orgId, table.at.desc()),
  ]
);
