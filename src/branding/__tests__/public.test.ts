import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../__tests__/db.js";
import { seedOrg, seedUser } from "../../__tests__/fixtures.js";
import { testEnv } from "../../__tests__/helpers.js";
import { buildApp } from "../../app.js";
import type { Db } from "../../db/client.js";
import { upsertLogo } from "../logo.repository.js";
import { JPEG, PNG } from "./files.js";

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;

beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
  app = await buildApp({ env: testEnv(), db });
});
afterAll(async () => {
  await app.close();
  await closeDb();
});

async function orgWithLogo(isActive = true, dark = false) {
  const org = await seedOrg(db, { isActive });
  const user = await seedUser(db);
  const etag = createHash("sha256").update(PNG).digest("hex");
  await upsertLogo(db, {
    orgId: org.id,
    content: PNG,
    mime: "image/png",
    etag,
    updatedBy: user.id,
  });
  if (dark) {
    await upsertLogo(
      db,
      { orgId: org.id, content: JPEG, mime: "image/jpeg", etag: "dark-etag", updatedBy: user.id },
      "dark"
    );
  }
  return { org, etag };
}

describe("GET /branding/orgs/:slug/logo", () => {
  it("serves an active org's logo with safe, cacheable headers", async () => {
    const { org, etag } = await orgWithLogo();
    const res = await app.inject({ url: `/branding/orgs/${org.slug}/logo` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers.etag).toBe(`"${etag}"`);
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");

    const again = await app.inject({
      url: `/branding/orgs/${org.slug}/logo`,
      headers: { "if-none-match": `"${etag}"` },
    });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  it("answers 404 for an inactive org, an unknown slug and an org without a logo", async () => {
    const { org: inactive } = await orgWithLogo(false);
    const bare = await seedOrg(db);
    for (const slug of [inactive.slug, "no-such-org", bare.slug]) {
      expect((await app.inject({ url: `/branding/orgs/${slug}/logo` })).statusCode).toBe(404);
    }
  });
});

describe("GET /branding/orgs/:slug/logo?variant=", () => {
  it("serves the dark variant with the same headers and 304 behavior", async () => {
    const { org } = await orgWithLogo(true, true);
    const res = await app.inject({ url: `/branding/orgs/${org.slug}/logo?variant=dark` });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(JPEG)).toBe(true);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers.etag).toBe('"dark-etag"');
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    const again = await app.inject({
      url: `/branding/orgs/${org.slug}/logo?variant=dark`,
      headers: { "if-none-match": '"dark-etag"' },
    });
    expect(again.statusCode).toBe(304);
  });

  it("serves the default for variant=default or none, and 404s a missing dark or unknown variant", async () => {
    const { org } = await orgWithLogo();
    for (const q of ["", "?variant=default"]) {
      const res = await app.inject({ url: `/branding/orgs/${org.slug}/logo${q}` });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(PNG)).toBe(true);
    }
    for (const q of ["?variant=dark", "?variant=light"]) {
      expect((await app.inject({ url: `/branding/orgs/${org.slug}/logo${q}` })).statusCode).toBe(
        404
      );
    }
  });
});
