import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { memberships, users } from "../db/schema/index.js";

/** The live state the admin guard re-checks on every request; `undefined` when the user is gone. */
export async function findAdminActor(db: Db, userId: string, orgId: string) {
  const [user] = await db
    .select({ isActive: users.isActive, isPlatformAdmin: users.isPlatformAdmin })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return undefined;
  const [member] = await db
    .select({ isActive: memberships.isActive })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)));
  return { ...user, memberActive: member?.isActive === true };
}
