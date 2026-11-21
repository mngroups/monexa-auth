import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { type Adapter, type AdapterPayload, errors } from "oidc-provider";
import type { Db } from "../db/client.js";
import { type AppRow, apps, oidcStore } from "../db/schema/index.js";
import { decryptSecret } from "./secrets.js";

export type AdapterOptions = { clientSecretKey: Buffer };

/** Client metadata for an `apps` row; the extra properties feed TTLs and access checks. */
export function clientMetadata(app: AppRow, clientSecretKey: Buffer): AdapterPayload {
  return {
    client_id: app.clientId,
    client_secret: decryptSecret(app.clientSecretEnc, clientSecretKey),
    client_name: app.name,
    redirect_uris: app.redirectUris,
    post_logout_redirect_uris: app.postLogoutRedirectUris,
    grant_types: [...app.allowedGrants, "refresh_token"],
    response_types: app.allowedGrants.includes("authorization_code") ? ["code"] : [],
    token_endpoint_auth_method: "client_secret_basic",
    app_id: app.id,
    access_ttl_seconds: app.accessTtlSeconds,
    refresh_ttl_seconds: app.refreshTtlSeconds,
  };
}

class ClientAdapter implements Adapter {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer
  ) {}

  async find(id: string) {
    const [app] = await this.db
      .select()
      .from(apps)
      .where(and(eq(apps.clientId, id), eq(apps.isActive, true)));
    return app ? clientMetadata(app, this.key) : undefined;
  }

  // Clients are managed through `apps` (admin API), never by the provider.
  async upsert() {
    throw new Error("clients are read-only");
  }
  findByUid = this.notSupported;
  findByUserCode = this.notSupported;
  consume = this.notSupported;
  destroy = this.notSupported;
  revokeByGrantId = this.notSupported;
  private async notSupported(): Promise<undefined> {
    return undefined;
  }
}

/** Postgres-backed storage for one provider model (`kind`), over `oidc_store`. */
class StoreAdapter implements Adapter {
  constructor(
    private readonly db: Db,
    private readonly kind: string
  ) {}

  private live() {
    return and(
      eq(oidcStore.kind, this.kind),
      or(isNull(oidcStore.expiresAt), gt(oidcStore.expiresAt, sql`now()`))
    );
  }

  private async findWhere(where: ReturnType<typeof and>) {
    const [r] = await this.db
      .select({ payload: oidcStore.payload, consumedAt: oidcStore.consumedAt })
      .from(oidcStore)
      .where(and(this.live(), where))
      .limit(1);
    if (!r) return undefined;
    const payload = r.payload as AdapterPayload;
    return r.consumedAt
      ? { ...payload, consumed: Math.floor(r.consumedAt.getTime() / 1000) }
      : payload;
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
    const grantId = payload.grantId ?? null;
    const userId = payload.accountId ?? null;
    // A Grant carries its org; tokens of a grant inherit it so access can be revoked by org.
    const orgId =
      this.kind === "Grant"
        ? sql`${(payload as { orgId?: string }).orgId ?? null}::uuid`
        : sql`(select g.org_id from oidc_store g where g.kind = 'Grant' and g.id = ${grantId})`;
    const values = {
      payload: payload as Record<string, unknown>,
      grantId,
      uid: payload.uid ?? null,
      userId,
      orgId,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
      consumedAt: null,
    };
    await this.db
      .insert(oidcStore)
      .values({ id, kind: this.kind, ...values })
      .onConflictDoUpdate({ target: [oidcStore.kind, oidcStore.id], set: values });
  }

  find(id: string) {
    return this.findWhere(eq(oidcStore.id, id));
  }

  findByUid(uid: string) {
    return this.findWhere(eq(oidcStore.uid, uid));
  }

  findByUserCode(userCode: string) {
    return this.findWhere(sql`${oidcStore.payload}->>'userCode' = ${userCode}`);
  }

  /**
   * Atomic: of two concurrent consumers (e.g. the same refresh token sent twice) exactly
   * one wins; the other gets `invalid_grant` instead of a second set of tokens.
   */
  async consume(id: string) {
    const updated = await this.db
      .update(oidcStore)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(oidcStore.kind, this.kind), eq(oidcStore.id, id), isNull(oidcStore.consumedAt)))
      .returning({ id: oidcStore.id });
    if (updated.length === 0) throw new errors.InvalidGrant(`${this.kind} already consumed`);
  }

  async destroy(id: string) {
    await this.db.delete(oidcStore).where(and(eq(oidcStore.kind, this.kind), eq(oidcStore.id, id)));
  }

  async revokeByGrantId(grantId: string) {
    await this.db
      .delete(oidcStore)
      .where(and(eq(oidcStore.kind, this.kind), eq(oidcStore.grantId, grantId)));
  }
}

/** The provider's adapter factory: `Client` reads `apps`, every other model uses `oidc_store`. */
export function createAdapter(db: Db, { clientSecretKey }: AdapterOptions) {
  return (kind: string): Adapter =>
    kind === "Client" ? new ClientAdapter(db, clientSecretKey) : new StoreAdapter(db, kind);
}
