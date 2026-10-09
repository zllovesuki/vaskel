import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationState } from "@vaskel/contracts/notifications";

type Sounds = typeof import("@/client/features/notifications/message-sounds");

const accountId = "00000000-0000-4000-8000-000000000001";
const roomId = "00000000-0000-4000-8000-000000000002";
const arrival = {
  type: "activity" as const,
  owner: { kind: "server" as const, id: "circle" },
  channelId: roomId,
  generation: "00000000-0000-4000-8000-00000000000a",
  sequence: 4,
  direct: true,
};
function settings(
  room: {
    mode: "direct" | "all" | "nothing";
    mutedUntil: number | null;
  } | null,
  paused = false,
): NotificationState {
  return {
    accountId,
    revision: 1,
    publicKey: "",
    preferences: { paused, preview: "generic", language: "en" },
    devices: [],
    rooms: room ? [{ owner: arrival.owner, roomId, ...room }] : [],
  };
}
const allowed = settings(null);

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}
/** One origin's Web Locks, shared by every simulated tab. */
function lockManager() {
  const held = new Set<string>();
  return {
    held,
    query: async () => ({
      held: [...held].map((name) => ({ name, mode: "exclusive" })),
      pending: [],
    }),
    async request(
      name: string,
      options: { ifAvailable?: boolean } | ((lock: unknown) => unknown),
      callback?: (lock: unknown) => unknown,
    ) {
      const run = typeof options === "function" ? options : callback!;
      if (held.has(name)) return run(null);
      held.add(name);
      try {
        return await run({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}
class FakeContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  destination = {};
  started = 0;
  constructor(private readonly allowed = true) {}
  resume = vi.fn(() =>
    this.allowed
      ? Promise.resolve().then(() => {
          if (this.state !== "closed") this.state = "running";
        })
      : new Promise<void>(() => {}),
  );
  suspend = vi.fn(async () => {
    this.state = "suspended";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createGain() {
    const param = {
      value: 1,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
      setTargetAtTime() {},
    };
    return { gain: param, connect: (node: unknown) => node };
  }
  createOscillator() {
    return {
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: () => void this.started++,
      stop() {},
    };
  }
}

let storage: ReturnType<typeof memoryStorage>;
let locks: ReturnType<typeof lockManager> | undefined;
/** Each import is a separate tab: its own module state over shared storage and locks. */
async function tab(): Promise<Sounds> {
  vi.resetModules();
  return import("@/client/features/notifications/message-sounds");
}
async function unlocked(sounds: Sounds, context = new FakeContext()) {
  const player = new sounds.SoundPlayer(
    () => context as unknown as AudioContext,
  );
  player.unlock();
  await vi.advanceTimersByTimeAsync(0);
  return { player, context };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  storage = memoryStorage();
  locks = lockManager();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", {
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("navigator", {
    get locks() {
      return locks;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("message sound playback", () => {
  it("starts audio only after a gesture unlocked it and never schedules late", async () => {
    const sounds = await tab();
    const idle = new FakeContext();
    const waiting = new sounds.SoundPlayer(
      () => idle as unknown as AudioContext,
    );
    expect(await waiting.prepare()).toBe(false);
    expect(waiting.start()).toBe(false);
    expect(idle.started).toBe(0);

    const blocked = new FakeContext(false);
    const held = new sounds.SoundPlayer(
      () => blocked as unknown as AudioContext,
    );
    held.unlock();
    const prepared = held.prepare();
    await vi.advanceTimersByTimeAsync(300);
    expect(await prepared).toBe(false);
    expect(blocked.started).toBe(0);

    const { player, context } = await unlocked(sounds);
    // The unlock itself rests the device once its tail would have passed.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context.state).toBe("suspended");
    expect(await player.prepare()).toBe(true);
    expect(player.start()).toBe(true);
    expect(context.started).toBeGreaterThan(0);
    player.close();
    expect(context.state).toBe("closed");
    expect(await player.prepare()).toBe(false);
  });

  it("previews the chime from the settings click that unlocks audio", async () => {
    const contexts: FakeContext[] = [];
    vi.stubGlobal(
      "AudioContext",
      class extends FakeContext {
        constructor() {
          super();
          contexts.push(this);
        }
      },
    );
    const sounds = await tab();
    sounds.previewMessageSound();
    await vi.advanceTimersByTimeAsync(0);
    const [context] = contexts;
    expect(contexts).toHaveLength(1);
    expect(context?.started).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(context?.state).toBe("closed");
  });

  it("decides from the settings this tab last read", async () => {
    const { wantsSound } = await tab();
    const now = Date.now();
    const plain = { ...arrival, direct: false };
    expect(wantsSound(undefined, arrival, now)).toBe(false);
    expect(wantsSound(allowed, arrival, now)).toBe(true);
    expect(wantsSound(allowed, plain, now)).toBe(false);
    expect(
      wantsSound(settings({ mode: "all", mutedUntil: null }), plain, now),
    ).toBe(true);
    expect(
      wantsSound(settings({ mode: "nothing", mutedUntil: null }), arrival, now),
    ).toBe(false);
    expect(
      wantsSound(settings({ mode: "all", mutedUntil: now + 1 }), arrival, now),
    ).toBe(false);
    expect(
      wantsSound(settings({ mode: "all", mutedUntil: now - 1 }), plain, now),
    ).toBe(true);
    // Pausing stops push notifications, not message sounds.
    expect(wantsSound(settings(null, true), arrival, now)).toBe(true);
  });

  it("plays one cue per browser and spends the cooldown only on a started sound", async () => {
    const manager = lockManager();
    locks = manager;
    const first = await tab();
    const second = await tab();
    const a = await unlocked(first);
    const b = await unlocked(second);
    const current = () => true;
    const viewing = first.viewingLockName(
      accountId,
      arrival.owner,
      arrival.channelId,
    );

    const muted = settings({ mode: "direct", mutedUntil: Date.now() + 60_000 });
    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        muted,
        a.player,
        current,
      ),
    ).toBe(false);
    manager.held.add(viewing);
    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        allowed,
        a.player,
        current,
      ),
    ).toBe(false);
    expect(
      await second.playMessageSound(
        accountId,
        arrival,
        allowed,
        b.player,
        current,
      ),
    ).toBe(false);
    expect(storage.values.has("vaskel.messageSoundAt")).toBe(false);
    manager.held.delete(viewing);

    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        allowed,
        a.player,
        current,
      ),
    ).toBe(true);
    expect(
      await second.playMessageSound(
        accountId,
        arrival,
        allowed,
        b.player,
        current,
      ),
    ).toBe(false);
    expect(b.context.started).toBe(0);

    await vi.advanceTimersByTimeAsync(first.MESSAGE_SOUND_COOLDOWN_MS);
    expect(
      await second.playMessageSound(
        accountId,
        arrival,
        allowed,
        b.player,
        current,
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(first.MESSAGE_SOUND_COOLDOWN_MS);
    manager.held.add(`vaskel:message-sound:${accountId}`);
    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        allowed,
        a.player,
        current,
      ),
    ).toBe(false);
    manager.held.clear();
    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        allowed,
        a.player,
        () => false,
      ),
    ).toBe(false);
    first.setMessageSounds(false);
    expect(storage.values.get("vaskel.messageSounds")).toBe("off");
    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        allowed,
        a.player,
        current,
      ),
    ).toBe(false);
    first.setMessageSounds(true);
    expect(
      await first.playMessageSound(
        accountId,
        arrival,
        allowed,
        a.player,
        current,
      ),
    ).toBe(true);
  });

  it("keeps a tab's own view and cooldown without Web Locks or storage", async () => {
    locks = undefined;
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("Storage unavailable");
      },
      setItem: () => {
        throw new Error("Storage unavailable");
      },
      removeItem: () => {
        throw new Error("Storage unavailable");
      },
    });
    const sounds = await tab();
    expect(sounds.messageSoundsEnabled()).toBe(true);
    const { player } = await unlocked(sounds);
    const release = sounds.holdViewing(
      sounds.viewingLockName(accountId, arrival.owner, arrival.channelId),
    );
    expect(
      await sounds.playMessageSound(
        accountId,
        arrival,
        allowed,
        player,
        () => true,
      ),
    ).toBe(false);
    release();
    expect(
      await sounds.playMessageSound(
        accountId,
        arrival,
        allowed,
        player,
        () => true,
      ),
    ).toBe(true);
    expect(
      await sounds.playMessageSound(
        accountId,
        arrival,
        allowed,
        player,
        () => true,
      ),
    ).toBe(false);
    sounds.setMessageSounds(false);
    expect(sounds.messageSoundsEnabled()).toBe(false);
  });
});
