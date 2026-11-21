import { isPlatformPermission } from "../permissions.service.js";

describe("isPlatformPermission", () => {
  it("matches platform: and platform. groups, nothing else", () => {
    expect(isPlatformPermission("platform:all")).toBe(true);
    expect(isPlatformPermission("platform.org:manage")).toBe(true);
    expect(isPlatformPermission("platform.X:*")).toBe(true);
    expect(isPlatformPermission("platformer:all")).toBe(false);
    expect(isPlatformPermission("org.member:manage")).toBe(false);
  });
});
