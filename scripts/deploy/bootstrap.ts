// `pnpm deploy:bootstrap [--rotate]`: first-run admin, admin app and org on production.
// Asks for the admin email and password, runs the bootstrap with the production env loaded only
// into a child process, then stores the admin app secret in Vercel and redeploys.
import { storeAdminSecret } from "./admin-secret.js";
import { loadDeployConfig } from "./config.js";
import { runWithProdEnv } from "./prod.js";
import { ask } from "./prompt.js";
import { release } from "./release.js";
import { createVercel } from "./vercel.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("usage: pnpm deploy:bootstrap [--rotate]");
  console.log("  --rotate  issue a new admin app secret even though the app exists");
  process.exit(0);
}

const cfg = loadDeployConfig();
const email = await ask("Admin email: ");
const password = await ask("Admin password (hidden, >= 8 chars): ", { hidden: true });
const again = await ask("Repeat password: ", { hidden: true });
if (!email.includes("@") || password.length < 8 || password !== again) {
  console.error(
    "✗ need a real email and a password of at least 8 characters, typed twice the same"
  );
  process.exit(1);
}

const { code, secret } = await runWithProdEnv(cfg, "bootstrap-inner.ts", {
  args: args.includes("--rotate") ? ["--rotate"] : [],
  env: {
    BOOTSTRAP_ADMIN_EMAIL: email,
    BOOTSTRAP_ADMIN_PASSWORD: password,
    BOOTSTRAP_ADMIN_REDIRECT_URIS: cfg.adminCallback,
    BOOTSTRAP_ADMIN_POST_LOGOUT_REDIRECT_URIS: cfg.adminLogout,
  },
});
if (code !== 0) process.exit(code);

const v = createVercel(cfg.team);
if (secret) {
  await storeAdminSecret(cfg, v, secret);
  process.exit((await release(cfg, v, ["auth"])) ? 0 : 1);
}
console.log(
  "Admin app already existed: ADMIN_CLIENT_SECRET left as it is (use --rotate for a new one)."
);
