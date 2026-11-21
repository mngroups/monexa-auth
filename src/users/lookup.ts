import { eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { type UserRow, users } from "../db/schema/index.js";

/** Finds a user by email or username, both case-insensitive. The identifier is trimmed. */
export async function findUserByIdentifier(db: Db, identifier: string): Promise<UserRow | null> {
  const id = identifier.trim();
  if (id === "") return null;
  const [row] = await db
    .select()
    .from(users)
    .where(or(eq(users.email, id), sql`lower(${users.username}) = lower(${id})`))
    .limit(1);
  return row ?? null;
}
