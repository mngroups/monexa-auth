import { randomBytes } from "node:crypto";
import type { DeployConfig } from "./config.js";
import type { Vercel } from "./vercel.js";

/** A new admin app secret, made by the caller so it can be saved before the database changes. */
export const newAdminSecret = () => randomBytes(32).toString("base64url");

/** Whether ADMIN_CLIENT_SECRET exists in production (its value can never be read back). */
export async function hasAdminSecret(cfg: DeployConfig, v: Vercel): Promise<boolean> {
  return (await v.envList(cfg.auth.project)).some((e) => e.key === "ADMIN_CLIENT_SECRET");
}

/**
 * Saves ADMIN_CLIENT_SECRET (sensitive) from memory. Vercel bakes env into each deployment, so
 * this changes nothing that is running: it is the safe first step of a rotation.
 */
export async function storeAdminSecret(cfg: DeployConfig, v: Vercel, secret: string) {
  const exists = await hasAdminSecret(cfg, v);
  await v.envSet(
    cfg.auth.project,
    "ADMIN_CLIENT_SECRET",
    secret,
    "sensitive",
    exists ? "update" : "add"
  );
  console.log(
    `✓ ADMIN_CLIENT_SECRET ${exists ? "updated" : "added"} in Vercel (sensitive, never printed)`
  );
}

export const LOGIN_WINDOW_WARNING =
  "Admin sign-in stops working from the database update until the new deployment is READY (a few minutes).";
