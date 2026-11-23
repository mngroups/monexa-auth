// Runs under `vercel env run` (see prod.ts): smoke checks with the production CRON_SECRET.
import { loadDeployConfig } from "./config.js";
import { runSmoke } from "./smoke.js";

const cron = process.env.CRON_SECRET;
const results = await runSmoke(fetch, loadDeployConfig(), {
  cronSecret: cron && cron !== "[SENSITIVE]" ? cron : undefined,
});
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `: ${r.detail}`}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
