import { and, asc, count, eq, ilike, ne, or } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { memberRoles, memberships, roles, type UserRow, users } from "../../db/schema/index.js";
import { containsPattern, type PageQuery, paging } from "../platform/common.js";

export type MemberRow = {
  userId: string;
  email: string;
  username: string | null;
  name: string;
  mustChangePassword: boolean;
  isActive: boolean;
};

const memberColumns = {
  userId: users.id,
  email: users.email,
  username: users.username,
  name: users.name,
  mustChangePassword: users.mustChangePassword,
  isActive: memberships.isActive,
};

export async function listMembers(db: Db, orgId: string, q: PageQuery & { q?: string }) {
  const pattern = q.q ? containsPattern(q.q) : undefined;
  const where = and(
    eq(memberships.orgId, orgId),
    pattern
      ? or(ilike(users.email, pattern), ilike(users.username, pattern), ilike(users.name, pattern))
      : undefined
  );
  const items: MemberRow[] = await db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(where)
    .orderBy(asc(users.name), asc(users.id))
    .limit(paging(q).limit)
    .offset(paging(q).offset);
  const [row] = await db
    .select({ total: count() })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(where);
  return { items, total: row?.total ?? 0 };
}

export async function findMember(
  db: Db,
  orgId: string,
  userId: string
): Promise<MemberRow | undefined> {
  const [row] = await db
    .select(memberColumns)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  return row;
}

/** The member's roles in this org, as `{ id, name, appId }`, by user id. */
export async function rolesOfMembers(db: Db, orgId: string, userIds: string[]) {
  const byUser = new Map<string, { id: string; name: string; appId: string }[]>();
  if (userIds.length === 0) return byUser;
  const rows = await db
    .select({ userId: memberRoles.userId, id: roles.id, name: roles.name, appId: roles.appId })
    .from(memberRoles)
    .innerJoin(roles, eq(roles.id, memberRoles.roleId))
    .where(eq(memberRoles.orgId, orgId))
    .orderBy(asc(roles.name), asc(roles.id));
  const wanted = new Set(userIds);
  for (const { userId, ...role } of rows) {
    if (!wanted.has(userId)) continue;
    byUser.set(userId, [...(byUser.get(userId) ?? []), role]);
  }
  return byUser;
}

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.email, email));
  return row;
}

export async function findUser(db: Db, userId: string): Promise<UserRow | undefined> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row;
}

export async function insertMembership(db: Db, orgId: string, userId: string) {
  await db.insert(memberships).values({ orgId, userId });
}

export async function deleteMembership(db: Db, orgId: string, userId: string) {
  await db
    .delete(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
}

export async function deleteMemberRoles(db: Db, orgId: string, userId: string) {
  await db
    .delete(memberRoles)
    .where(and(eq(memberRoles.orgId, orgId), eq(memberRoles.userId, userId)));
}

export async function setMembershipActive(
  db: Db,
  orgId: string,
  userId: string,
  isActive: boolean
) {
  await db
    .update(memberships)
    .set({ isActive })
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
}

/** Whether the user belongs to any org other than this one. */
export async function belongsToOtherOrg(db: Db, orgId: string, userId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), ne(memberships.orgId, orgId)));
  return (row?.total ?? 0) > 0;
}

export async function resetPassword(db: Db, userId: string, passwordHash: string) {
  await db
    .update(users)
    .set({
      passwordHash,
      mustChangePassword: true,
      failedLogins: 0,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
}
