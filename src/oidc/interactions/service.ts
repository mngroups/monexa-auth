import { MESSAGES } from "@mono/server-kit";
import { eq } from "drizzle-orm";
import type Provider from "oidc-provider";
import type { Client, InteractionResults } from "oidc-provider";
import { eligibleOrgs } from "../../access/eligibility.js";
import { resolveAccess } from "../../access/permissions.js";
import { logActivity } from "../../activity/log.js";
import type { Db } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import type { Env } from "../../env.js";
import { MESSAGES_AUTH } from "../../messages.js";
import { findUserByIdentifier } from "../../users/lookup.js";
import { newPasswordError } from "../../users/password-policy.js";
import { checkPasswordLogin, hashPassword } from "../../users/passwords.js";
import {
  appClient,
  type GrantRefusal,
  grantTtl,
  type OrgGrant,
  revokeGrant,
} from "../grant-access.js";
import type { ViewName } from "./render.js";

export type Interaction = Awaited<ReturnType<Provider["interactionDetails"]>>;

export type InteractionDeps = { db: Db; env: Env; provider: Provider };
export type Audit = { ip?: string; userAgent?: string };

/** What the route does next: render a page, or finish the interaction (back to the provider). */
export type Outcome =
  | { kind: "render"; view: ViewName; status: number; data: Record<string, unknown> }
  | { kind: "finish"; result: InteractionResults };

/** Form fields of the interaction pages (all optional: a form can be tampered with). */
export type InteractionForm = {
  step?: string;
  identifier?: string;
  password?: string;
  current_password?: string;
  new_password?: string;
  confirm_password?: string;
  org_id?: string;
};

/**
 * Progress kept on the Interaction itself (in the store, never in memory): who signed in,
 * whether by password in this interaction, and whether a password change is still owed.
 */
type FlowState = { accountId: string; passwordLogin: boolean; changePassword?: boolean };

type Ctx = InteractionDeps & { interaction: Interaction; client: Client; audit: Audit };

function render(ctx: Ctx, view: ViewName, data: Record<string, unknown> = {}, status = 200) {
  return { kind: "render", view, status, data: { uid: ctx.interaction.uid, ...data } } as const;
}

const errorPage = (ctx: Ctx, message: string, status: number) =>
  render(ctx, "error", { message }, status);

function stateOf(interaction: Interaction): FlowState | undefined {
  return interaction.result?.monexa as FlowState | undefined;
}

async function saveState(interaction: Interaction, state: FlowState): Promise<void> {
  interaction.result = { monexa: state };
  await interaction.save(interaction.exp - Math.floor(Date.now() / 1000));
}

async function logFailure(ctx: Ctx, reason: GrantRefusal, userId: string | null) {
  await logActivity(ctx.db, {
    actorUserId: userId,
    orgId: null,
    action: "auth.login.failed",
    targetType: "user",
    // Never the submitted identifier: users sometimes type their password into it.
    targetId: userId ?? "unknown",
    ...ctx.audit,
    metadata: { client_id: ctx.client.clientId, reason },
  });
}

async function activeUser(db: Db, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  return user?.isActive ? user : undefined;
}

/** The interaction's client; `undefined` once the app is deactivated. */
async function loadClient(deps: InteractionDeps, interaction: Interaction) {
  return deps.provider.Client.find(interaction.params.client_id as string);
}

/** The app was deactivated since the authorize: nowhere to send the browser back to. */
function clientGone(interaction: Interaction): Outcome {
  return {
    kind: "render",
    view: "error",
    status: 400,
    data: { uid: interaction.uid, message: MESSAGES.badRequest },
  };
}

/** GET: the page for where the interaction stands. */
export async function showInteraction(
  deps: InteractionDeps,
  interaction: Interaction,
  audit: Audit
): Promise<Outcome> {
  const client = await loadClient(deps, interaction);
  if (!client) return clientGone(interaction);
  const ctx: Ctx = { ...deps, interaction, client, audit };

  const state = stateOf(interaction);
  if (state) return state.changePassword ? render(ctx, "change-password") : orgStep(ctx, state);

  // A central session already exists (another app, or a remembered grant that no longer
  // fits): no password again, but the user must still be active and pick the org.
  const sessionAccount = interaction.prompt.name === "consent" && interaction.session?.accountId;
  if (sessionAccount) {
    const user = await activeUser(deps.db, sessionAccount);
    if (!user) return render(ctx, "login");
    const next: FlowState = {
      accountId: user.id,
      passwordLogin: false,
      ...(user.mustChangePassword ? { changePassword: true } : {}),
    };
    await saveState(interaction, next);
    return next.changePassword ? render(ctx, "change-password") : orgStep(ctx, next);
  }
  return render(ctx, "login");
}

/** POST: applies one form step and returns the next page (or the finished result). */
export async function submitInteraction(
  deps: InteractionDeps,
  interaction: Interaction,
  form: InteractionForm,
  audit: Audit
): Promise<Outcome> {
  const client = await loadClient(deps, interaction);
  if (!client) return clientGone(interaction);
  const ctx: Ctx = { ...deps, interaction, client, audit };
  const state = stateOf(interaction);

  if (form.step === "login") return loginStep(ctx, form);
  if (form.step === "change-password" && state?.changePassword) {
    return changePasswordStep(ctx, state, form);
  }
  if (form.step === "select-org" && state && !state.changePassword) {
    return finish(ctx, state, form.org_id ?? "");
  }
  // A step out of order (back button, tampering): show where the interaction stands.
  return showInteraction(deps, interaction, audit);
}

async function loginStep(ctx: Ctx, form: InteractionForm): Promise<Outcome> {
  const identifier = form.identifier ?? "";
  const login = await checkPasswordLogin(ctx.db, identifier, form.password ?? "", {
    maxFailures: ctx.env.LOCKOUT_MAX_FAILURES,
    lockMinutes: ctx.env.LOCKOUT_MINUTES,
  });
  if (login.ok) {
    const state: FlowState = { accountId: login.user.id, passwordLogin: true };
    await saveState(ctx.interaction, state);
    return orgStep(ctx, state);
  }

  const known = await findUserByIdentifier(ctx.db, identifier);
  if (login.reason === "password_change_required" && known) {
    await saveState(ctx.interaction, {
      accountId: known.id,
      passwordLogin: true,
      changePassword: true,
    });
    return render(ctx, "change-password");
  }
  await logFailure(ctx, "invalid_credentials", known?.id ?? null);
  return render(ctx, "login", { identifier, error: MESSAGES.invalidCredentials }, 401);
}

async function changePasswordStep(
  ctx: Ctx,
  state: FlowState,
  form: InteractionForm
): Promise<Outcome> {
  const next = form.new_password ?? "";
  const invalid = (error: string) => render(ctx, "change-password", { error }, 400);
  const policyError = newPasswordError(next, form.confirm_password);
  if (policyError) return invalid(policyError);

  const user = await activeUser(ctx.db, state.accountId);
  if (!user) return render(ctx, "login", { error: MESSAGES.invalidCredentials }, 401);
  // Same check as a login (lockout included): only the right password owes a change.
  const check = await checkPasswordLogin(ctx.db, user.email, form.current_password ?? "", {
    maxFailures: ctx.env.LOCKOUT_MAX_FAILURES,
    lockMinutes: ctx.env.LOCKOUT_MINUTES,
  });
  const verified = check.ok || check.reason === "password_change_required";
  if (!verified) {
    await logFailure(ctx, "invalid_credentials", user.id);
    return invalid(MESSAGES_AUTH.currentPasswordWrong);
  }

  const passwordHash = await hashPassword(next);
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await logActivity(tx, {
      actorUserId: user.id,
      orgId: null,
      action: "auth.password.changed",
      targetType: "user",
      targetId: user.id,
      ...ctx.audit,
      metadata: { client_id: ctx.client.clientId },
    });
  });
  const done: FlowState = { accountId: user.id, passwordLogin: state.passwordLogin };
  await saveState(ctx.interaction, done);
  return orgStep(ctx, done);
}

/** An eligible `org_hint` or a single eligible org is used directly; otherwise the picker. */
async function orgStep(ctx: Ctx, state: FlowState): Promise<Outcome> {
  const orgs = await eligibleOrgs(ctx.db, state.accountId, appClient(ctx.client).app_id, {
    adminClientId: ctx.env.ADMIN_CLIENT_ID,
  });
  const hint = ctx.interaction.params.org_hint;
  const direct = orgs.find((o) => o.id === hint) ?? (orgs.length === 1 ? orgs[0] : undefined);
  if (orgs.length === 0 || direct) return finish(ctx, state, direct?.id ?? "");
  return pickerPage(ctx, state, orgs);
}

async function pickerPage(
  ctx: Ctx,
  state: FlowState,
  orgs: { id: string; name: string }[],
  error?: string
) {
  const user = await activeUser(ctx.db, state.accountId);
  const checked = orgs.find((o) => o.id === user?.lastOrgId)?.id ?? orgs[0]?.id;
  return render(ctx, "select-org", { orgs, checked, error }, error ? 400 : 200);
}

async function sessionGrantId(ctx: Ctx): Promise<string | undefined> {
  const uid = ctx.interaction.session?.uid;
  const session = uid ? await ctx.provider.Session.findByUid(uid) : undefined;
  return session?.grantIdFor(ctx.client.clientId);
}

/** Resolves access for the org, creates the Grant (with `orgId`, `openid`) and finishes. */
async function finish(ctx: Ctx, state: FlowState, orgId: string): Promise<Outcome> {
  const user = await activeUser(ctx.db, state.accountId);
  if (!user) return render(ctx, "login", { error: MESSAGES.invalidCredentials }, 401);
  const appId = appClient(ctx.client).app_id;
  const adminClientId = ctx.env.ADMIN_CLIENT_ID;
  const access = await resolveAccess(ctx.db, {
    userId: user.id,
    appId,
    orgId: orgId || undefined,
    adminClientId,
  });
  if (!access.ok) {
    if (state.passwordLogin) await logFailure(ctx, access.reason, user.id);
    if (access.reason === "no_app_access") return errorPage(ctx, MESSAGES_AUTH.noAppAccess, 403);
    const orgs = await eligibleOrgs(ctx.db, user.id, appId, { adminClientId });
    return pickerPage(ctx, state, orgs, MESSAGES_AUTH.orgNotEligible);
  }

  // The session remembers one grant per app; the new one replaces it. Revoke the old one
  // now, or its refresh tokens would outlive the logout (which only revokes the session's).
  const replaced = await sessionGrantId(ctx);
  if (replaced) await revokeGrant(ctx.provider, replaced);

  const grant = new ctx.provider.Grant({
    accountId: user.id,
    clientId: ctx.client.clientId,
  }) as OrgGrant & { expiresIn: number };
  // Saved outside a provider request, where `ttl.Grant` has no context to read the client from.
  grant.expiresIn = grantTtl(ctx.client);
  grant.orgId = access.org.id;
  grant.addOIDCScope("openid");
  const grantId = await grant.save();

  await ctx.db.update(users).set({ lastOrgId: access.org.id }).where(eq(users.id, user.id));
  if (state.passwordLogin) {
    await logActivity(ctx.db, {
      actorUserId: user.id,
      orgId: access.org.id,
      action: "auth.login.succeeded",
      targetType: "user",
      targetId: user.id,
      ...ctx.audit,
      metadata: { client_id: ctx.client.clientId },
    });
  }
  return {
    kind: "finish",
    result: { login: { accountId: user.id }, consent: { grantId } },
  };
}
