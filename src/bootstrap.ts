import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import {
  appPermissions,
  apps,
  memberships,
  orgApps,
  organizations,
  rolePermissions,
  roles,
  users,
} from "./db/schema/index.js";
import { encryptSecret } from "./oidc/secrets.js";
import { newPasswordError } from "./users/password-policy.js";
import { hashPassword } from "./users/passwords.js";

const ORG_PERMISSIONS = [
  "org.member:manage",
  "org.role:assign",
  "org.activity:view",
  "org.branding:manage",
] as const;
const CATALOG = ["platform:all", ...ORG_PERMISSIONS] as const;

export type BootstrapParams = {
  adminEmail: string;
  adminPassword: string;
  adminRedirectUris: string[];
  /** Where the admin UI returns after central logout; added to the app, never removed. */
  adminPostLogoutRedirectUris: string[];
  /** `client_id` of the admin app (env ADMIN_CLIENT_ID). */
  adminClientId: string;
  /** Decoded CLIENT_SECRET_KEY (32 bytes). */
  secretKey: Buffer;
  /** Issue a new admin app secret even though the app exists (recovery when it was lost). */
  rotateAdminSecret?: boolean;
};

/**
 * First-run setup, safe to repeat: the platform admin, the sso-only admin app with its
 * permission catalog, the "Org Admin" role and the "Monexa" org with the admin app enabled
 * (the admin is a member). Existing rows are kept as they are, except that the admin user is
 * made an active platform admin again. The client secret is returned only when the app is created,
 * or when `rotateAdminSecret` replaces the existing one.
 */
export async function bootstrap(
  db: Db,
  p: BootstrapParams
): Promise<{ adminClientSecret: string | null }> {
  const passwordHash = await hashPassword(p.adminPassword);
  const secret = randomBytes(32).toString("base64url");

  return db.transaction(async (tx) => {
    const [existingUser] = await tx.select().from(users).where(eq(users.email, p.adminEmail));
    const admin = existingUser
      ? (
          await tx
            .update(users)
            .set({ isPlatformAdmin: true, isActive: true })
            .where(eq(users.id, existingUser.id))
            .returning()
        )[0]
      : (
          await tx
            .insert(users)
            .values({
              email: p.adminEmail,
              name: "Platform Admin",
              passwordHash,
              isPlatformAdmin: true,
            })
            .returning()
        )[0];

    let adminClientSecret: string | null = null;
    let [app] = await tx.select().from(apps).where(eq(apps.clientId, p.adminClientId));
    if (!app) {
      [app] = await tx
        .insert(apps)
        .values({
          clientId: p.adminClientId,
          name: "Monexa Admin",
          clientSecretEnc: encryptSecret(secret, p.secretKey),
          redirectUris: p.adminRedirectUris,
          postLogoutRedirectUris: p.adminPostLogoutRedirectUris,
          allowedGrants: ["authorization_code"],
        })
        .returning();
      adminClientSecret = secret;
    } else {
      const missing = p.adminPostLogoutRedirectUris.filter(
        (uri) => !app?.postLogoutRedirectUris.includes(uri)
      );
      if (missing.length > 0) {
        await tx
          .update(apps)
          .set({
            postLogoutRedirectUris: [...app.postLogoutRedirectUris, ...missing],
            updatedAt: new Date(),
          })
          .where(eq(apps.id, app.id));
      }
      if (p.rotateAdminSecret) {
        await tx
          .update(apps)
          .set({ clientSecretEnc: encryptSecret(secret, p.secretKey), updatedAt: new Date() })
          .where(eq(apps.id, app.id));
        adminClientSecret = secret;
      }
    }
    const appId = (app as { id: string }).id;

    await tx
      .insert(appPermissions)
      .values(CATALOG.map((permission) => ({ appId, permission })))
      .onConflictDoNothing();

    let [role] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.appId, appId), eq(roles.name, "Org Admin")));
    if (!role) {
      [role] = await tx.insert(roles).values({ appId, name: "Org Admin" }).returning();
    }
    await tx
      .insert(rolePermissions)
      .values(
        ORG_PERMISSIONS.map((permission) => ({ roleId: (role as { id: string }).id, permission }))
      )
      .onConflictDoNothing();

    let [org] = await tx.select().from(organizations).where(eq(organizations.slug, "monexa"));
    if (!org) {
      [org] = await tx.insert(organizations).values({ slug: "monexa", name: "Monexa" }).returning();
    }
    const orgId = (org as { id: string }).id;
    await tx.insert(orgApps).values({ orgId, appId }).onConflictDoNothing();
    await tx
      .insert(memberships)
      .values({ userId: (admin as { id: string }).id, orgId })
      .onConflictDoNothing();

    return { adminClientSecret };
  });
}

const DEFAULT_REDIRECT = "http://localhost:3001/auth/callback";
const DEFAULT_POST_LOGOUT = "http://localhost:3001/login";

const csv = (raw: string | undefined) =>
  (raw ?? "")
    .split(",")
    .map((uri) => uri.trim())
    .filter(Boolean);

/**
 * Reads the CLI inputs from env. The password goes through the shared policy; the error
 * names the variable, never the value.
 */
export function readBootstrapEnv(
  source: NodeJS.ProcessEnv,
  env: { ADMIN_CLIENT_ID: string; CLIENT_SECRET_KEY: string }
): BootstrapParams {
  const adminEmail = source.BOOTSTRAP_ADMIN_EMAIL?.trim();
  const adminPassword = source.BOOTSTRAP_ADMIN_PASSWORD;
  if (!adminEmail) throw new Error("BOOTSTRAP_ADMIN_EMAIL is required");
  if (!adminPassword) throw new Error("BOOTSTRAP_ADMIN_PASSWORD is required");
  const problem = newPasswordError(adminPassword, adminPassword);
  if (problem) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD rejected: ${problem}`);
  const uris = csv(source.BOOTSTRAP_ADMIN_REDIRECT_URIS);
  const postLogoutUris = csv(source.BOOTSTRAP_ADMIN_POST_LOGOUT_REDIRECT_URIS);
  return {
    adminEmail,
    adminPassword,
    adminRedirectUris: uris.length > 0 ? uris : [DEFAULT_REDIRECT],
    adminPostLogoutRedirectUris: postLogoutUris.length > 0 ? postLogoutUris : [DEFAULT_POST_LOGOUT],
    adminClientId: env.ADMIN_CLIENT_ID,
    secretKey: Buffer.from(env.CLIENT_SECRET_KEY, "base64"),
    rotateAdminSecret: source.BOOTSTRAP_ROTATE_ADMIN_SECRET === "true",
  };
}
