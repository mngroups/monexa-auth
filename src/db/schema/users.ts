import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** Case-insensitive text (needs `CREATE EXTENSION citext`, done in the first migration). */
export const citext = customType<{ data: string }>({
  dataType: () => "citext",
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: citext("email").notNull().unique(),
    username: text("username"),
    name: text("name").notNull(),
    /** argon2id. */
    passwordHash: text("password_hash"),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastOrgId: uuid("last_org_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_username_lower_idx").on(sql`lower(${table.username})`)]
);

export type UserRow = typeof users.$inferSelect;
