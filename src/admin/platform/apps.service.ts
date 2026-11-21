import { randomBytes } from "node:crypto";
import { AppError } from "@mono/server-kit";
import type { Db } from "../../db/client.js";
import type { AppGrant, AppRow } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { encryptSecret } from "../../oidc/secrets.js";
import * as repo from "./apps.repository.js";
import { type Actor, audit, iso, orConflict, type PageQuery } from "./common.js";

/** The app as the API shows it: never the (encrypted) client secret. */
export const toApp = (a: AppRow) => ({
  id: a.id,
  clientId: a.clientId,
  name: a.name,
  redirectUris: a.redirectUris,
  postLogoutRedirectUris: a.postLogoutRedirectUris,
  allowedGrants: a.allowedGrants,
  accessTtlSeconds: a.accessTtlSeconds,
  refreshTtlSeconds: a.refreshTtlSeconds,
  isActive: a.isActive,
  createdAt: iso(a.createdAt),
  updatedAt: iso(a.updatedAt),
});

const newSecret = () => randomBytes(32).toString("base64url");
const secretKey = (env: Env) => Buffer.from(env.CLIENT_SECRET_KEY, "base64");

export type AppInput = {
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  allowedGrants: AppGrant[];
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
};

export async function listApps(db: Db, q: PageQuery & { q?: string }) {
  const { items, total } = await repo.listApps(db, q);
  return { items: items.map(toApp), page: q.page, pageSize: q.pageSize, total };
}

export async function getApp(db: Db, id: string) {
  const app = await repo.findApp(db, id);
  if (!app) throw new AppError(404, MESSAGES_AUTH.appNotFound);
  return toApp(app);
}

/** The only place (with `rotateSecret`) the plaintext secret is returned; it is never stored or logged. */
export function createApp(db: Db, env: Env, actor: Actor, input: AppInput & { clientId: string }) {
  const secret = newSecret();
  return orConflict(MESSAGES_AUTH.clientIdTaken, () =>
    db.transaction(async (tx) => {
      const app = await repo.insertApp(tx, {
        ...input,
        clientSecretEnc: encryptSecret(secret, secretKey(env)),
      });
      await audit(tx, actor, {
        action: "admin.app.created",
        targetType: "app",
        targetId: app.id,
        metadata: { clientId: app.clientId, name: app.name },
      });
      return { ...toApp(app), clientSecret: secret };
    })
  );
}

export function updateApp(db: Db, actor: Actor, id: string, input: Partial<AppInput>) {
  return db.transaction(async (tx) => {
    const app = await repo.updateApp(tx, id, input);
    if (!app) throw new AppError(404, MESSAGES_AUTH.appNotFound);
    await audit(tx, actor, {
      action: "admin.app.updated",
      targetType: "app",
      targetId: id,
      metadata: { fields: Object.keys(input) },
    });
    return toApp(app);
  });
}

export function setAppActive(db: Db, actor: Actor, id: string, isActive: boolean) {
  return db.transaction(async (tx) => {
    const app = await repo.updateApp(tx, id, { isActive });
    if (!app) throw new AppError(404, MESSAGES_AUTH.appNotFound);
    await audit(tx, actor, {
      action: isActive ? "admin.app.activated" : "admin.app.deactivated",
      targetType: "app",
      targetId: id,
    });
    return toApp(app);
  });
}

export function rotateSecret(db: Db, env: Env, actor: Actor, id: string) {
  const secret = newSecret();
  return db.transaction(async (tx) => {
    const app = await repo.updateApp(tx, id, {
      clientSecretEnc: encryptSecret(secret, secretKey(env)),
    });
    if (!app) throw new AppError(404, MESSAGES_AUTH.appNotFound);
    await audit(tx, actor, {
      action: "admin.app.secret_rotated",
      targetType: "app",
      targetId: id,
      metadata: { clientId: app.clientId },
    });
    return { id: app.id, clientId: app.clientId, clientSecret: secret };
  });
}
