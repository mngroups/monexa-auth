import { enableApp, seedApp, seedRole } from "../../../__tests__/fixtures.js";
import { bootOrg, type OrgHarness } from "./harness.js";

let h: OrgHarness;
beforeAll(async () => {
  h = await bootOrg();
});
afterAll(async () => h.close());

describe("GET /org/roles", () => {
  it("lists roles of apps enabled for the token's org, by app name then role name", async () => {
    const zeta = await seedApp(h.db, { name: "Zeta" });
    const alpha = await seedApp(h.db, { name: "Alpha" });
    const hidden = await seedApp(h.db, { name: "Hidden" });
    await enableApp(h.db, h.orgA.id, zeta.id);
    await enableApp(h.db, h.orgA.id, alpha.id);
    const zEditor = await seedRole(h.db, zeta.id, "editor");
    const aViewer = await seedRole(h.db, alpha.id, "viewer");
    const aAdmin = await seedRole(h.db, alpha.id, "admin");
    await seedRole(h.db, hidden.id, "secret");

    const res = await h.call("GET", "/roles");
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { id: string; name: string; appName: string }[];
    expect(data.map((r) => r.id)).toEqual([aAdmin.id, aViewer.id, zEditor.id]);
    expect(data[0]).toEqual({
      id: aAdmin.id,
      name: "admin",
      description: "",
      appId: alpha.id,
      appName: "Alpha",
    });
    expect(data.some((r) => r.name === "secret")).toBe(false);
  });

  it("needs org.role:assign", async () => {
    const token = await h.tokenFor(h.admin.id, h.orgA.id, ["org.member:manage"]);
    expect((await h.call("GET", "/roles", undefined, token)).statusCode).toBe(403);
  });
});
