import { seedOrg } from "../../../__tests__/fixtures.js";
import { logActivity } from "../../../activity/log.js";
import { type Admin, bootAdmin } from "../../__tests__/harness.js";

let h: Admin;
beforeAll(async () => {
  h = await bootAdmin();
});
afterAll(async () => h.close());

describe("activity", () => {
  it("lists the full log newest first, filtered by org, action and date, paginated", async () => {
    const org = await seedOrg(h.db);
    const other = await seedOrg(h.db);
    const log = (orgId: string, action: string) =>
      logActivity(h.db, {
        actorUserId: h.user.id,
        orgId,
        action,
        targetType: "org",
        targetId: orgId,
        metadata: { n: action },
      });
    await log(org.id, "admin.org.created");
    await log(org.id, "admin.org.updated");
    await log(other.id, "admin.org.created");

    const mine = (await h.call("GET", `/activity?orgId=${org.id}`)).json().data;
    expect(mine.total).toBe(2);
    expect(mine.items.map((i: { action: string }) => i.action)).toEqual([
      "admin.org.updated",
      "admin.org.created",
    ]);
    expect(mine.items[0]).toMatchObject({ orgId: org.id, metadata: { n: "admin.org.updated" } });

    const created = (await h.call("GET", "/activity?action=admin.org.created")).json().data;
    expect(created.total).toBe(2);
    expect(
      (await h.call("GET", `/activity?orgId=${org.id}&action=admin.org.created`)).json().data.total
    ).toBe(1);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    expect((await h.call("GET", `/activity?from=${future}`)).json().data.total).toBe(0);
    expect((await h.call("GET", `/activity?to=${past}`)).json().data.total).toBe(0);
    expect((await h.call("GET", `/activity?from=${past}&to=${future}`)).json().data.total).toBe(3);

    const page = (await h.call("GET", "/activity?pageSize=2&page=2")).json().data;
    expect(page).toMatchObject({ page: 2, pageSize: 2, total: 3 });
    expect(page.items).toHaveLength(1);
  });

  it("answers 422 for invalid filters", async () => {
    expect((await h.call("GET", "/activity?orgId=nope")).statusCode).toBe(422);
    expect((await h.call("GET", "/activity?from=yesterday")).statusCode).toBe(422);
    expect((await h.call("GET", "/activity?pageSize=1000")).statusCode).toBe(422);
  });
});
