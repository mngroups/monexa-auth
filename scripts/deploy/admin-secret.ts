import type { DeployConfig } from "./config.js";
import type { Vercel } from "./vercel.js";

/** Stores ADMIN_CLIENT_SECRET (sensitive) from memory: `update` when it exists, else `add`. */
export async function storeAdminSecret(cfg: DeployConfig, v: Vercel, secret: string) {
  const exists = (await v.envList(cfg.auth.project)).some((e) => e.key === "ADMIN_CLIENT_SECRET");
  await v.envSet(
    cfg.auth.project,
    "ADMIN_CLIENT_SECRET",
    secret,
    "sensitive",
    exists ? "update" : "add"
  );
  console.log(`✓ ADMIN_CLIENT_SECRET ${exists ? "updated" : "added"} (sensitive, never printed)`);
}
