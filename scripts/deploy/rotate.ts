// `pnpm deploy:rotate admin-secret|db`
//   admin-secret: new admin app secret in the database and in Vercel, checked, then redeployed.
//   db:           after a Neon password reset (the integration updates the URLs): checks that
//                 the new URLs connect, then redeploys so the running functions pick them up.
import { storeAdminSecret } from "./admin-secret.js";
import { loadDeployConfig } from "./config.js";
import { runWithProdEnv } from "./prod.js";
import { release } from "./release.js";
import { createVercel } from "./vercel.js";

const what = process.argv[2];
if (what !== "admin-secret" && what !== "db") {
  console.log("usage: pnpm deploy:rotate admin-secret|db");
  process.exit(what === "--help" ? 0 : 1);
}

const cfg = loadDeployConfig();
const v = createVercel(cfg.team);
const { code, secret } = await runWithProdEnv(cfg, "rotate-inner.ts", { args: [what] });
if (code !== 0) process.exit(code);
if (what === "admin-secret") {
  if (!secret) {
    console.error("✗ no secret came back");
    process.exit(1);
  }
  await storeAdminSecret(cfg, v, secret);
}
process.exit((await release(cfg, v, ["auth"])) ? 0 : 1);
