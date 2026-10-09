import { afterAll, expect, it, vi } from "vitest";

afterAll(() => vi.unstubAllGlobals());

it("keeps the selected and applied theme aligned when device storage refuses writes", async () => {
  const dataset: Record<string, string> = {};
  vi.stubGlobal("document", { documentElement: { dataset } });
  // Frames run at once, so the transition pause is over after each switch.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    callback(0),
  );
  vi.stubGlobal("localStorage", {
    getItem: () => "light",
    setItem: () => {
      throw new Error("Storage unavailable");
    },
    removeItem: () => {
      throw new Error("Storage unavailable");
    },
  });
  const theme = await import("@/client/ui/theme");
  theme.applyTheme();
  expect(dataset.theme).toBe("light");
  theme.setTheme("dark");
  expect(theme.getTheme()).toBe("dark");
  expect(dataset.theme).toBe("dark");
  theme.setTheme("system");
  expect(theme.getTheme()).toBe("system");
  expect(dataset.theme).toBeUndefined();
  expect(dataset.themeSwitching).toBeUndefined();
});
