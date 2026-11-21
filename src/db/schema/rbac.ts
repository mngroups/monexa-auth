import { pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const appPermissions = pgTable(
  "app_permissions",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    /** `group[.resource]:action` */
    permission: text("permission").notNull(),
    description: text("description").notNull().default(""),
  },
  (table) => [primaryKey({ columns: [table.appId, table.permission] })]
);

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  appId: uuid("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permission] })]
);

export const orgApps = pgTable(
  "org_apps",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    appId: uuid("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.appId] })]
);

export const memberRoles = pgTable(
  "member_roles",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.orgId, table.roleId] })]
);
