import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOrg } from "../../../__tests__/fixtures.js";
import { multipart, PNG } from "../../../branding/__tests__/files.js";
import { type Admin, bootAdmin, MISSING_ID } from "../../__tests__/harness.js";

let h: Admin;
beforeAll(async () => {
  h = await bootAdmin();
});
afterAll(async () => h.close());

const upload = (orgId: string) => {
  const body = multipart(PNG);
  return h.app.inject({
    method: "PUT",
    url: `/api/admin/platform/orgs/${orgId}/logo`,
    payload: body.payload,
    headers: { ...body.headers, authorization: `Bearer ${h.token}` },
  });
};

describe("org logo (platform admin)", () => {
  it("sets and removes any org's logo, and the org list shows its state", async () => {
    const org = await seedOrg(h.db, { name: "Zeta Logo" });
    const listed = async () =>
      (await h.call("GET", "/orgs?q=Zeta")).json().data.items[0] as { logo: unknown };

    expect((await listed()).logo).toBeNull();
    const res = await upload(org.id);
    expect(res.statusCode).toBe(200);
    expect((await listed()).logo).toEqual({
      etag: res.json().data.etag,
      updatedAt: expect.any(String),
    });

    expect((await h.call("DELETE", `/orgs/${org.id}/logo`)).statusCode).toBe(200);
    expect((await listed()).logo).toBeNull();
  });

  it("answers 404 for an unknown org", async () => {
    expect((await upload(MISSING_ID)).statusCode).toBe(404);
    expect((await h.call("DELETE", `/orgs/${MISSING_ID}/logo`)).statusCode).toBe(404);
  });
});
