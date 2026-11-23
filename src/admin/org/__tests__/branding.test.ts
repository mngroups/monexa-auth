import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JPEG, multipart, PNG, SVG } from "../../../branding/__tests__/files.js";
import { orgLogos } from "../../../db/schema/index.js";
import { activityOf } from "../../__tests__/harness.js";
import { bootOrg, ORG_PERMISSIONS, type OrgHarness } from "./harness.js";

let h: OrgHarness;
beforeAll(async () => {
  h = await bootOrg();
});
afterAll(async () => h.close());

const BRANDING = [...ORG_PERMISSIONS, "org.branding:manage"];

async function upload(token: string, body = multipart(PNG), url = "/api/admin/org/logo") {
  return h.app.inject({
    method: "PUT",
    url,
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${token}` },
  });
}

const logoOf = async (orgId: string) =>
  (await h.db.select().from(orgLogos).where(eq(orgLogos.orgId, orgId)))[0];

describe("org logo (org admin)", () => {
  it("stores an uploaded logo for the token's org and logs it", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    const res = await upload(token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ etag: expect.any(String), updatedAt: expect.any(String) });
    const row = await logoOf(h.orgA.id);
    expect(row?.mime).toBe("image/png");
    expect(Buffer.from(row?.content as Uint8Array).equals(PNG)).toBe(true);
    expect(await activityOf(h.db, "org.logo.updated")).toHaveLength(1);
    expect(await logoOf(h.orgB.id)).toBeUndefined();
  });

  it("replaces the logo, detecting the type from the bytes", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    expect((await upload(token, multipart(JPEG, "brand.png", "image/png"))).statusCode).toBe(200);
    expect((await logoOf(h.orgA.id))?.mime).toBe("image/jpeg");
  });

  it("refuses a script disguised as a PNG and stores nothing", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgB.id, BRANDING);
    await import("../../../__tests__/fixtures.js").then(({ addMember }) =>
      addMember(h.db, h.admin.id, h.orgB.id)
    );
    const res = await upload(token, multipart(SVG, "logo.png", "image/png"));
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe("Logo harus berupa PNG, JPG, atau WebP.");
    expect(await logoOf(h.orgB.id)).toBeUndefined();
  });

  it("refuses a logo over 512 KB", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    const big = Buffer.concat([PNG, Buffer.alloc(524_288, 0)]);
    const res = await upload(token, multipart(big));
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe("Ukuran logo maksimal 512 KB.");
  });

  it("refuses a request without a file", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    const res = await h.app.inject({
      method: "PUT",
      url: "/api/admin/org/logo",
      payload: {},
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(422);
  });

  it("needs org.branding:manage", async () => {
    expect((await upload(h.token)).statusCode).toBe(403);
  });

  it("removes the logo and logs it", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    const res = await h.call("DELETE", "/logo", undefined, token);
    expect(res.statusCode).toBe(200);
    expect(await logoOf(h.orgA.id)).toBeUndefined();
    expect(await activityOf(h.db, "org.logo.removed")).toHaveLength(1);
  });

  it("can't reach the platform logo route of another org", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    const res = await upload(token, multipart(PNG), `/api/admin/platform/orgs/${h.orgB.id}/logo`);
    expect(res.statusCode).toBe(403);
    expect(await logoOf(h.orgB.id)).toBeUndefined();
  });
});

describe("GET /org/branding", () => {
  it("returns the token's org slug, name and logo state", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, BRANDING);
    const get = () =>
      h.app.inject({
        method: "GET",
        url: "/api/admin/org/branding",
        headers: { authorization: `Bearer ${token}` },
      });
    await h.db.delete(orgLogos).where(eq(orgLogos.orgId, h.orgA.id));
    const before = await get();
    expect(before.statusCode).toBe(200);
    expect(before.json().data).toEqual({ slug: h.orgA.slug, name: h.orgA.name, logo: null });
    expect((await upload(token)).statusCode).toBe(200);
    expect((await get()).json().data.logo).toEqual({
      etag: expect.any(String),
      updatedAt: expect.any(String),
    });
  });

  it("needs org.branding:manage", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: "/api/admin/org/branding",
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
