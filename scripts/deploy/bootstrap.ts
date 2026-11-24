// `pnpm deploy:bootstrap [--rotate]`: first-run admin, admin app and org on production.
// When a secret is needed (new app, or --rotate) it is made here and saved in Vercel first,
// so a failure later never loses it; the database step then stores the same secret.
import {
  hasAdminSecret,
  LOGIN_WINDOW_WARNING,
  newAdminSecret,
  storeAdminSecret,
} from "./admin-secret.js";
import { loadDeployConfig } from "./config.js";
import { runWithProdEnv } from "./prod.js";
import { ask } from "./prompt.js";
import { release } from "./release.js";
import { createVercel } from "./vercel.js";

const APP_EXISTS = 10; // exit code of `bootstrap-inner.ts --check` when the admin app exists

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("usage: pnpm deploy:bootstrap [--rotate]");
  console.log("  --rotate  issue a new admin app secret even though the app exists");
  process.exit(0);
}
const rotate = args.includes("--rotate");
const cfg = loadDeployConfig();
const v = createVercel(cfg.team);

const email = await ask("Admin email: ");
const password = await ask("Admin password (hidden, >= 8 chars): ", { hidden: true });
const again = await ask("Repeat password: ", { hidden: true });
if (!email.includes("@") || password.length < 8 || password !== again) {
  console.error(
    "✗ need a real email and a password of at least 8 characters, typed twice the same"
  );
  process.exit(1);
}

const check = await runWithProdEnv(cfg, "bootstrap-inner.ts", { args: ["--check"] });
if (check !== 0 && check !== APP_EXISTS) process.exit(1);
const appExists = check === APP_EXISTS;
const needsSecret = !appExists || rotate;

let secret: string | undefined;
if (needsSecret) {
  if (appExists) console.log(`! ${LOGIN_WINDOW_WARNING}`);
  secret = newAdminSecret();
  try {
    await storeAdminSecret(cfg, v, secret);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}. Nothing changed; safe to re-run.`);
    process.exit(1);
  }
}

const code = await runWithProdEnv(cfg, "bootstrap-inner.ts", {
  args: rotate ? ["--rotate"] : [],
  env: {
    BOOTSTRAP_ADMIN_EMAIL: email,
    BOOTSTRAP_ADMIN_PASSWORD: password,
    BOOTSTRAP_ADMIN_REDIRECT_URIS: cfg.adminCallback,
    BOOTSTRAP_ADMIN_POST_LOGOUT_REDIRECT_URIS: cfg.adminLogout,
    ...(secret ? { DEPLOY_NEW_ADMIN_SECRET: secret } : {}),
  },
});
if (code !== 0) {
  if (secret) {
    console.error(
      "✗ Vercel holds a new ADMIN_CLIENT_SECRET that the database may not. Re-run " +
        "`pnpm deploy:bootstrap --rotate` before deploying monexa-auth again."
    );
  }
  process.exit(1);
}

if (secret) {
  if (!(await release(cfg, v, ["auth"]))) {
    console.error(
      "✗ No new deployment is READY: admin sign-in fails until one is (`pnpm deploy:release auth`)."
    );
    process.exit(1);
  }
} else if (!(await hasAdminSecret(cfg, v))) {
  console.error(
    "✗ The admin app exists but ADMIN_CLIENT_SECRET is not in Vercel: run `pnpm deploy:bootstrap --rotate`."
  );
  process.exit(1);
} else {
  console.log(
    "✓ Admin app already existed; ADMIN_CLIENT_SECRET left as it is (--rotate issues a new one)."
  );
}
