import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { replaceAlarm, scheduleAlarm } from "@/server/actors/shared/alarms";

function probe() {
  return env.DATABASE_PROBE.getByName(`alarm-boundary:${crypto.randomUUID()}`);
}

describe("native alarm transaction boundary", () => {
  it("only advances producer wakes and permits exact refresh to move or remove them", async () => {
    await runInDurableObject(probe(), async (_instance, { storage }) => {
      const early = Date.now() + 60_000;
      const late = early + 60_000;
      await storage.transaction(async () => {
        await scheduleAlarm(storage, late);
        await scheduleAlarm(storage, early);
        await scheduleAlarm(storage, late);
      });
      expect(await storage.getAlarm()).toBe(early);
      await storage.transaction(() => replaceAlarm(storage, late));
      expect(await storage.getAlarm()).toBe(late);
      await storage.transaction(() => replaceAlarm(storage, null));
      expect(await storage.getAlarm()).toBeNull();
    });
  });

  it("rolls back the obligation and alarm when the alarm write fails", async () => {
    await runInDurableObject(probe(), async (_instance, { storage }) => {
      storage.sql.exec(
        "CREATE TABLE obligations (id TEXT PRIMARY KEY, due INTEGER)",
      );
      const original = Date.now() + 120_000;
      await storage.setAlarm(original);
      const setAlarm = storage.setAlarm.bind(storage);
      const failure = vi
        .spyOn(storage, "setAlarm")
        .mockImplementation(async (due) => {
          await setAlarm(due);
          throw new Error("injected alarm write failure");
        });
      try {
        await expect(
          storage.transaction(async () => {
            storage.sql.exec(
              "INSERT INTO obligations VALUES ('new', ?)",
              original - 60_000,
            );
            await scheduleAlarm(storage, original - 60_000);
          }),
        ).rejects.toThrow("injected alarm write failure");
      } finally {
        failure.mockRestore();
      }
      expect(storage.sql.exec("SELECT * FROM obligations").toArray()).toEqual(
        [],
      );
      expect(await storage.getAlarm()).toBe(original);
      await storage.deleteAlarm();
    });
  });

  it("restores pruned rows and their wake if the pruning transaction fails", async () => {
    await runInDurableObject(probe(), async (_instance, { storage }) => {
      storage.sql.exec(
        "CREATE TABLE obligations (id TEXT PRIMARY KEY, due INTEGER)",
      );
      const due = Date.now() + 60_000;
      await storage.transaction(async () => {
        storage.sql.exec("INSERT INTO obligations VALUES ('retained', ?)", due);
        await scheduleAlarm(storage, due);
      });
      await expect(
        storage.transaction(async () => {
          storage.sql.exec("DELETE FROM obligations");
          await replaceAlarm(storage, null);
          throw new Error("injected pruning failure");
        }),
      ).rejects.toThrow("injected pruning failure");
      expect(storage.sql.exec("SELECT * FROM obligations").toArray()).toEqual([
        { id: "retained", due },
      ]);
      expect(await storage.getAlarm()).toBe(due);
      await storage.deleteAlarm();
    });
  });
});
