import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../__tests__/db.js";
import { seedOrg, seedUser } from "../../__tests__/fixtures.js";
import type { Db } from "../../db/client.js";
import { orgLogos, orgLogosDark } from "../../db/schema/index.js";
import { deleteLogo, logoMetaByOrgIds, upsertLogo } from "../logo.repository.js";
import { JPEG, PNG } from "./files.js";

let db: Db;
let closeDb: () => Promise<void>;
beforeAll(async () => {
  ({ db, close: closeDb } = await createTestDb());
});
afterAll(async () => closeDb());

const rowsOf = async (orgId: string) => [
  ...(await db.select().from(orgLogos).where(eq(orgLogos.orgId, orgId))).map((r) => ({
    variant: "default",
    ...r,
  })),
  ...(await db.select().from(orgLogosDark).where(eq(orgLogosDark.orgId, orgId))).map((r) => ({
    variant: "dark",
    ...r,
  })),
];

describe("org logo variants (repository)", () => {
  it("upserts each variant independently, and a missing variant means default", async () => {
    const org = await seedOrg(db);
    const user = await seedUser(db);
    const base = { orgId: org.id, mime: "image/png", updatedBy: user.id };
    await upsertLogo(db, { ...base, content: PNG, etag: "a" });
    await upsertLogo(db, { ...base, content: JPEG, etag: "b" }, "dark");
    await upsertLogo(db, { ...base, content: PNG, etag: "c" }, "default");
    const rows = await rowsOf(org.id);
    expect(rows.map((r) => [r.variant, r.etag]).sort()).toEqual([
      ["dark", "b"],
      ["default", "c"],
    ]);
    const metas = await logoMetaByOrgIds(db, [org.id]);
    expect(metas.get(org.id)?.logo?.etag).toBe("c");
    expect(metas.get(org.id)?.logoDark?.etag).toBe("b");
  });

  it("deletes only the named variant", async () => {
    const org = await seedOrg(db);
    const user = await seedUser(db);
    const base = { orgId: org.id, mime: "image/png", updatedBy: user.id, content: PNG };
    await upsertLogo(db, { ...base, etag: "a" });
    await upsertLogo(db, { ...base, etag: "b" }, "dark");
    expect(await deleteLogo(db, org.id, "dark")).toBe(true);
    expect(await deleteLogo(db, org.id, "dark")).toBe(false);
    expect((await rowsOf(org.id)).map((r) => r.variant)).toEqual(["default"]);
    expect(await deleteLogo(db, org.id, "default")).toBe(true);
    expect(await rowsOf(org.id)).toEqual([]);
  });
});
