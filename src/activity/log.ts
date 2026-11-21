import type { Db } from "../db/client.js";
import { activityLog } from "../db/schema/index.js";

export type ActivityEvent = {
  actorUserId: string | null;
  orgId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  ip?: string;
  userAgent?: string;
  /** Never a password, hash, token, client secret or code. */
  metadata?: Record<string, unknown>;
};

/** Appends one `activity_log` row; pass the transaction when the change it records has one. */
export async function logActivity(tx: Db, e: ActivityEvent): Promise<void> {
  await tx.insert(activityLog).values({
    actorUserId: e.actorUserId,
    orgId: e.orgId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    metadata: e.metadata ?? {},
  });
}
