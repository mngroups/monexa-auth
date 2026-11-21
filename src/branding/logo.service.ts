import { createHash } from "node:crypto";
import { AppError } from "@mono/server-kit";
import { type Actor, audit, iso } from "../admin/platform/common.js";
import type { Db } from "../db/client.js";
import { MESSAGES_AUTH } from "../messages.js";
import * as repo from "./logo.repository.js";
import { detectLogoMime, LOGO_MAX_BYTES } from "./logo-file.js";

export type LogoUpload = { content: Buffer; truncated: boolean };

export const toLogo = (meta: repo.LogoMeta | undefined) =>
  meta ? { etag: meta.etag, updatedAt: iso(meta.updatedAt) } : null;

/** Validates and stores an org's logo (type from the bytes, ≤ 512 KB) and logs the change. */
export function setLogo(db: Db, actor: Actor, orgId: string, file: LogoUpload | undefined) {
  if (!file) throw new AppError(422, MESSAGES_AUTH.logoMissing);
  if (file.truncated || file.content.length > LOGO_MAX_BYTES) {
    throw new AppError(422, MESSAGES_AUTH.logoTooLarge);
  }
  const mime = detectLogoMime(file.content);
  if (!mime) throw new AppError(422, MESSAGES_AUTH.logoInvalidType);
  const etag = createHash("sha256").update(file.content).digest("hex");
  return db.transaction(async (tx) => {
    const meta = await repo.upsertLogo(tx, {
      orgId,
      content: file.content,
      mime,
      etag,
      updatedBy: actor.userId,
    });
    await audit(tx, actor, {
      action: "org.logo.updated",
      targetType: "org",
      targetId: orgId,
      orgId,
      metadata: { mime, size: file.content.length },
    });
    return toLogo(meta) as { etag: string; updatedAt: string };
  });
}

export function removeLogo(db: Db, actor: Actor, orgId: string) {
  return db.transaction(async (tx) => {
    if (await repo.deleteLogo(tx, orgId)) {
      await audit(tx, actor, {
        action: "org.logo.removed",
        targetType: "org",
        targetId: orgId,
        orgId,
      });
    }
    return null;
  });
}
