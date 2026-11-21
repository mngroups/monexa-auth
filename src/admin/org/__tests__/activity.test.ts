import { logActivity } from "../../../activity/log.js";
import { bootOrg, type OrgHarness } from "./harness.js";

let h: OrgHarness;
beforeAll(async () => {
  h = await bootOrg();
});
afterAll(async () => h.close());

describe("org activity", () => {
  it("lists only the admin org's rows, filterable by action, and requires org.activity:view", async () => {
    const ev = (orgId: string, action: string) =>
      logActivity(h.db, {
        actorUserId: h.admin.id,
        orgId,
        action,
        targetType: "user",
        targetId: "t",
      });
    await ev(h.orgA.id, "admin.member.added");
    await ev(h.orgA.id, "admin.member.removed");
    await ev(h.orgB.id, "admin.member.added");
    await ev(h.orgB.id, "secret.b.only");
    const all = (await h.call("GET", "/activity")).json().data;
    expect(all.total).toBe(2);
    expect(all.items.every((r: { orgId: string }) => r.orgId === h.orgA.id)).toBe(true);
    expect(JSON.stringify(all)).not.toContain("secret.b.only");
    const filtered = (await h.call("GET", "/activity?action=admin.member.added")).json().data;
    expect(filtered.total).toBe(1);
    // an orgId query param must not widen the scope
    const widened = (await h.call("GET", `/activity?orgId=${h.orgB.id}`)).json().data;
    expect(widened.items.every((r: { orgId: string }) => r.orgId === h.orgA.id)).toBe(true);
    const noPerm = await h.tokenFor(h.admin.id, h.orgA.id, ["org.member:manage"]);
    expect((await h.call("GET", "/activity", undefined, noPerm)).statusCode).toBe(403);
  });
});
