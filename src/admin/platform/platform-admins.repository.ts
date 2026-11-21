import { asc, count, eq, ilike, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { apps, type UserRow, users } from "../../db/schema/index.js";
import { containsPattern, type PageQuery, paging } from "./common.js";

export async function listUsers(db: Db, q: PageQuery & { q?: string }) {
  const pattern = q.q ? containsPattern(q.q) : undefined;
  const where = pattern
    ? or(ilike(users.email, pattern), ilike(users.username, pattern), ilike(users.name, pattern))
    : undefined;
  const items = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(asc(users.name), asc(users.id))
    .limit(paging(q).limit)
    .offset(paging(q).offset);
  const [row] = await db.select({ total: count() }).from(users).where(where);
  return { items, total: row?.total ?? 0 };
}

export async function insertUser(
  db: Db,
  v: { email: string; username?: string; name: string; passwordHash: string }
) {
  const [row] = await db
    .insert(users)
    .values({ ...v, mustChangePassword: true })
    .returning();
  return row as UserRow;
}

export async function setPlatformAdmin(db: Db, userId: string, isPlatformAdmin: boolean) {
  const [row] = await db
    .update(users)
    .set({ isPlatformAdmin, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return row;
}

export async function findAppIdByClientId(db: Db, clientId: string): Promise<string | undefined> {
  const [row] = await db.select({ id: apps.id }).from(apps).where(eq(apps.clientId, clientId));
  return row?.id;
}

export async function setUserActive(db: Db, userId: string, isActive: boolean) {
  const [row] = await db
    .update(users)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return row;
}

/** A temporary password: must be changed at next sign-in; clears any lockout. */
export async function setTemporaryPassword(db: Db, userId: string, passwordHash: string) {
  const [row] = await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      failedLogins: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();
  return row;
}
