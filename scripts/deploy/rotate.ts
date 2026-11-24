// `pnpm deploy:rotate admin-secret|db`
//   admin-secret: new admin app secret. Order: Vercel env (nothing running changes) → database
//                 + live check → release. Each failure says exactly what state it left.
//   db:           after a Neon password reset (the integration updates the URLs): checks that
//                 the new URLs connect, then redeploys so the running functions pick them up.
import { LOGIN_WINDOW_WARNING, newAdminSecret, storeAdminSecret } from "./admin-secret.js";
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

if (what === "db") {
  if ((await runWithProdEnv(cfg, "rotate-inner.ts", { args: ["db"] })) !== 0) process.exit(1);
  process.exit((await release(cfg, v, ["auth"])) ? 0 : 1);
}

console.log(`! ${LOGIN_WINDOW_WARNING}`);
const secret = newAdminSecret();
try {
  await storeAdminSecret(cfg, v, secret);
} catch (err) {
  console.error(`✗ ${(err as Error).message}. Nothing changed; safe to re-run.`);
  process.exit(1);
}

const code = await runWithProdEnv(cfg, "rotate-inner.ts", {
  args: ["admin-secret"],
  env: { DEPLOY_NEW_ADMIN_SECRET: secret },
});
if (code !== 0) {
  console.error(
    "✗ Vercel holds the new ADMIN_CLIENT_SECRET but the database may not. The running deployment " +
      "still matches the database, so sign-in works until the next deploy. Re-run " +
      "`pnpm deploy:rotate admin-secret` before deploying monexa-auth again."
  );
  process.exit(1);
}

if (!(await release(cfg, v, ["auth"]))) {
  console.error(
    "✗ Database and Vercel hold the new secret, but no new deployment is READY: admin sign-in " +
      "fails until one is. Fix the build, then `pnpm deploy:release auth`."
  );
  process.exit(1);
}
