import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedOrg } from "../../../__tests__/fixtures.js";
import { JPEG, multipart, PNG } from "../../../branding/__tests__/files.js";
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

describe("org logo variants (platform admin)", () => {
  it("sets and removes the dark variant independently, and the list shows logoDark", async () => {
    const org = await seedOrg(h.db, { name: "Eta Dark" });
    const listed = async () =>
      (await h.call("GET", "/orgs?q=Eta")).json().data.items[0] as {
        logo: unknown;
        logoDark: unknown;
      };
    const body = multipart(JPEG);
    const put = (variant: string) =>
      h.app.inject({
        method: "PUT",
        url: `/api/admin/platform/orgs/${org.id}/logo?variant=${variant}`,
        payload: body.payload,
        headers: { ...body.headers, authorization: `Bearer ${h.token}` },
      });
    expect(await listed()).toMatchObject({ logo: null, logoDark: null });
    await upload(org.id);
    expect((await put("dark")).statusCode).toBe(200);
    const meta = { etag: expect.any(String), updatedAt: expect.any(String) };
    expect(await listed()).toMatchObject({ logo: meta, logoDark: meta });

    expect((await h.call("DELETE", `/orgs/${org.id}/logo?variant=dark`)).statusCode).toBe(200);
    expect(await listed()).toMatchObject({ logo: meta, logoDark: null });
  });

  it("answers 422 for a bad variant", async () => {
    const org = await seedOrg(h.db, { name: "Theta Dark" });
    expect((await h.call("DELETE", `/orgs/${org.id}/logo?variant=blue`)).statusCode).toBe(422);
    const body = multipart(PNG);
    const res = await h.app.inject({
      method: "PUT",
      url: `/api/admin/platform/orgs/${org.id}/logo?variant=blue`,
      payload: body.payload,
      headers: { ...body.headers, authorization: `Bearer ${h.token}` },
    });
    expect(res.statusCode).toBe(422);
  });
});

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
