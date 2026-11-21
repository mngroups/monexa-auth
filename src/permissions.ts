/**
 * Permissions of the `monexa-admin` app, used with `app.requirePermission(...)` on
 * `/api/admin/*`. `platform:*` permissions come only from `is_platform_admin`, never from a role.
 */
export const PERMISSIONS = {
  platformAll: "platform:all",
  memberManage: "org.member:manage",
  roleAssign: "org.role:assign",
  activityView: "org.activity:view",
} as const;
