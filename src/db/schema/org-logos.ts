import { customType, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
});

/** One brand logo per org, shown on the login pages. Small (≤ 512 KB), so it lives here, not in object storage. */
export const orgLogos = pgTable("org_logos", {
  orgId: uuid("org_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  content: bytea("content").notNull(),
  /** Detected from the bytes, never taken from the upload's claim. */
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  /** sha-256 hex of `content`. */
  etag: text("etag").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
});

export type OrgLogoRow = typeof orgLogos.$inferSelect;
