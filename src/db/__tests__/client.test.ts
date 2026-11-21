import { sql } from "drizzle-orm";
import { createDb } from "../client.js";

describe("createDb", () => {
  it("does not connect until queried, and fails when the database is unreachable", async () => {
    const { db, close } = createDb("postgres://u:p@127.0.0.1:1/x", 2);
    await expect(db.execute(sql`select 1`)).rejects.toThrow();
    await close();
  });

  it("survives an idle-client error instead of crashing the process", async () => {
    const seen: Error[] = [];
    const { pool, close } = createDb("postgres://u:p@127.0.0.1:1/x", 1, {
      onIdleError: (err) => seen.push(err),
    });
    const err = new Error("terminating connection due to administrator command");
    expect(() => pool.emit("error", err)).not.toThrow();
    expect(seen).toEqual([err]);
    await close();
  });

  it("logs idle-client errors by default", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { pool, close } = createDb("postgres://u:p@127.0.0.1:1/x", 1);
    pool.emit("error", new Error("boom"));
    expect(warn).toHaveBeenCalledWith("idle postgres client error:", "boom");
    warn.mockRestore();
    await close();
  });

  it("gives up connecting after the connect timeout instead of hanging", async () => {
    // 10.255.255.1 is unroutable: without a timeout the connect waits for the OS (minutes).
    const { db, close } = createDb("postgres://u:p@10.255.255.1:5432/x", 1, {
      connectTimeoutMs: 200,
    });
    const started = Date.now();
    await expect(db.execute(sql`select 1`)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    await close();
  });
});
