import { addMember, enableApp, seedOrg, seedUser } from "../../../__tests__/fixtures.js";
import { type Admin, bootAdmin, mintToken } from "../../__tests__/harness.js";

export const ORG_PERMISSIONS = ["org.member:manage", "org.role:assign", "org.activity:view"];

export type OrgHarness = Awaited<ReturnType<typeof bootOrg>>;

/** The admin harness plus two orgs; `admin` is an org admin of A only (not a platform admin). */
export async function bootOrg() {
  const h: Admin = await bootAdmin();
  const orgA = await seedOrg(h.db);
  const orgB = await seedOrg(h.db);
  const admin = await seedUser(h.db);
  await addMember(h.db, admin.id, orgA.id);
  await enableApp(h.db, orgA.id, h.adminApp.id);
  const tokenFor = (sub: string, orgId: string, permissions = ORG_PERMISSIONS) =>
    mintToken(h.env, { sub, orgId, permissions });
  const token = await tokenFor(admin.id, orgA.id);
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: object,
    bearer: string = token
  ) =>
    h.app.inject({
      method,
      url: `/api/admin/org${url}`,
      payload,
      headers: { authorization: `Bearer ${bearer}` },
    });
  return { ...h, orgA, orgB, admin, token, tokenFor, call, orgCall: call };
}
