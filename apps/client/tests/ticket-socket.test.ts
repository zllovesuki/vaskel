import { deferred } from "@tests/shared/deferred";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectTicketSocket } from "@/client/api/ticket-socket";

class NativeSocket extends EventTarget {
  static OPEN = 1;
  static instances: NativeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    super();
    NativeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("Socket is not open");
    this.sent.push(data);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const disposals: (() => void)[] = [];
const connection = (
  ticket = vi.fn<(signal: AbortSignal) => Promise<string>>(async () => "fresh"),
  onError = vi.fn(),
  renew?: Parameters<typeof connectTicketSocket>[0]["renew"],
) => {
  const status = vi.fn();
  const onMessage = vi.fn();
  const socket = connectTicketSocket({
    path: "/api/socket",
    protocol: "vaskel-v1",
    ticket,
    active: () => true,
    status,
    onError,
    onMessage,
    ping: '{"type":"ping"}',
    leaseMarginMs: 1_000,
    ...(renew ? { renew } : {}),
  });
  disposals.push(() => socket.dispose());
  return { socket, status, onMessage, ticket, onError };
};
beforeEach(() => {
  vi.useFakeTimers();
  NativeSocket.instances = [];
  vi.stubGlobal("WebSocket", NativeSocket);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), { visibilityState: "visible" }),
  );
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", {
    origin: "https://vaskel.test",
    protocol: "https:",
  });
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ticketed PartySocket transport", () => {
  it("keeps the ready deadline after native open and waits for library backoff before retrying", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { ticket, status, onMessage } = connection();
    await vi.advanceTimersByTimeAsync(0);
    const first = NativeSocket.instances[0]!;
    first.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.readyState).toBe(3);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
    expect(ticket).toHaveBeenCalledOnce();
    first.receive("late ready");
    expect(onMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(699);
    expect(ticket).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(NativeSocket.instances).toHaveLength(2);
  });

  it("bounds repeated application retries without a tight admission loop", async () => {
    const { socket, ticket } = connection();
    const delays: number[] = [];
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 1; attempt <= 8; attempt++) {
      NativeSocket.instances.at(-1)!.open();
      const started = Date.now();
      socket.retry();
      await vi.advanceTimersByTimeAsync(699);
      expect(ticket).toHaveBeenCalledTimes(attempt);
      await vi.advanceTimersToNextTimerAsync();
      const delay = Date.now() - started;
      delays.push(delay);
      expect(delay).toBeLessThanOrEqual(15_000);
      expect(ticket).toHaveBeenCalledTimes(attempt + 1);
      expect(NativeSocket.instances).toHaveLength(attempt + 1);
    }
    expect(delays.at(-1)!).toBeGreaterThan(delays[0]!);
  });

  it("retries rejected admission with library backoff and never upgrades without a fresh ticket", async () => {
    const ticket = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new TypeError("unreachable"))
      .mockRejectedValueOnce(new TypeError("still unreachable"))
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const { onError, status } = connection(ticket);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
    expect(NativeSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(699);
    expect(ticket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(401);
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(NativeSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_201);
    expect(NativeSocket.instances).toHaveLength(1);
    const first = NativeSocket.instances[0]!;
    expect(first.protocols).toEqual(["vaskel-v1", "vaskel-ticket.first"]);
    first.close();
    await vi.advanceTimersByTimeAsync(4_401);
    expect(NativeSocket.instances).toHaveLength(2);
    expect(NativeSocket.instances[1]!.protocols).toEqual([
      "vaskel-v1",
      "vaskel-ticket.second",
    ]);
    expect(ticket).toHaveBeenCalledTimes(4);
  });

  it.each(["resolve", "reject"] as const)(
    "fences a delayed admission that will %s across offline and online, without disturbing the new socket",
    async (completion) => {
      const held = deferred<string>();
      const ticket = vi
        .fn<(signal: AbortSignal) => Promise<string>>()
        .mockReturnValueOnce(held.promise)
        .mockResolvedValueOnce("replacement");
      const { socket, onMessage, onError } = connection(ticket);
      await vi.advanceTimersByTimeAsync(0);
      const oldSignal = ticket.mock.calls[0]![0];
      vi.stubGlobal("navigator", { onLine: false });
      window.dispatchEvent(new Event("offline"));
      expect(oldSignal.aborted).toBe(true);
      expect(socket.send("stale typing")).toBe(false);
      vi.stubGlobal("navigator", { onLine: true });
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
      expect(NativeSocket.instances).toHaveLength(1);
      const replacement = NativeSocket.instances[0]!;
      replacement.open();
      socket.acceptReady(Date.now() + 30_000);
      if (completion === "resolve") held.resolve("obsolete");
      else held.reject(new Error("old request failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled();
      expect(NativeSocket.instances).toHaveLength(1);
      expect(replacement.readyState).toBe(1);
      expect(replacement.sent).toEqual([]);
      replacement.receive("current frame");
      expect(onMessage).toHaveBeenCalledOnce();
      expect(socket.send("current typing")).toBe(true);
      expect(replacement.sent).toEqual(["current typing"]);
    },
  );

  it("never starts a delayed provider after disposal or lets a held ticket reopen its lifetime", async () => {
    const unopened = connection();
    unopened.socket.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(unopened.ticket).not.toHaveBeenCalled();
    const held = deferred<string>();
    const pending = connection(vi.fn(() => held.promise));
    await vi.advanceTimersByTimeAsync(0);
    pending.socket.dispose();
    held.resolve("obsolete");
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(NativeSocket.instances).toHaveLength(0);
    expect(pending.ticket).toHaveBeenCalledOnce();
    expect(pending.onError).not.toHaveBeenCalled();
  });

  it("stops a rejected admission permanently when its application owner revokes access", async () => {
    const ticket = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValue(new Error("revoked"));
    const revoked = vi.fn(() => socket.dispose());
    const { socket } = connection(ticket, revoked);
    await vi.advanceTimersByTimeAsync(0);
    expect(revoked).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(ticket).toHaveBeenCalledOnce();
    expect(NativeSocket.instances).toHaveLength(0);
  });

  it("drops outbound frames while connecting and reconnecting, and ignores frames from the retired native socket", async () => {
    const { socket, onMessage } = connection();
    expect(socket.send("before ticket")).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    const first = NativeSocket.instances[0]!;
    expect(socket.send("before open")).toBe(false);
    first.open();
    expect(socket.send("before ready")).toBe(false);
    socket.acceptReady(Date.now() + 30_000);
    first.close();
    expect(socket.send("while reconnecting")).toBe(false);
    await vi.advanceTimersByTimeAsync(1_101);
    const second = NativeSocket.instances[1]!;
    second.open();
    socket.acceptReady(Date.now() + 30_000);
    expect(second.sent).toEqual([]);
    first.receive("old frame");
    expect(onMessage).not.toHaveBeenCalled();
    second.receive("new frame");
    expect(onMessage).toHaveBeenCalledOnce();
  });
});

describe("room socket authorization renewal", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  type Renewal = { connectionId: string; leaseExpiresAt: number };
  async function admitted(
    renew: NonNullable<Parameters<typeof connectTicketSocket>[0]["renew"]>,
    onError = vi.fn(),
  ) {
    const result = connection(undefined, onError, renew);
    await vi.advanceTimersByTimeAsync(0);
    const native = NativeSocket.instances[0]!;
    native.open();
    result.socket.acceptReady(Date.now() + 30_000, id);
    return { ...result, native };
  }

  it("extends only authorization, keeping one transport and the existing ping cadence", async () => {
    const renew = vi.fn(async () => ({
      connectionId: id,
      leaseExpiresAt: Date.now() + 30_000,
    }));
    const { socket, native, ticket } = await admitted(renew);
    await vi.advanceTimersByTimeAsync(25_000);
    socket.received(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(renew).toHaveBeenCalledOnce();
    expect(renew.mock.calls[0]).toEqual([id, expect.any(AbortSignal)]);
    expect(ticket).toHaveBeenCalledOnce();
    expect(NativeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(native.sent).toEqual(['{"type":"ping"}', '{"type":"ping"}']);
    expect(socket.isReady()).toBe(true);
  });

  it("does not let successful HTTP renewal acknowledge an outstanding ping", async () => {
    const renew = vi.fn(async () => ({
      connectionId: id,
      leaseExpiresAt: Date.now() + 30_000,
    }));
    const { native } = await admitted(renew);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(renew).toHaveBeenCalledOnce();
    expect(native.readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(native.readyState).toBe(3);
  });

  it("lets a session-capped lease expire without repeatedly trying to extend it", async () => {
    const expiresAt = Date.now() + 30_000;
    const renew = vi.fn(async () => ({
      connectionId: id,
      leaseExpiresAt: expiresAt,
    }));
    const { native } = await admitted(renew);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(renew).toHaveBeenCalledOnce();
    expect(native.readyState).toBe(3);
  });

  it.each(["resolve", "reject"] as const)(
    "expires a hung renewal and fences its late %s from the replacement",
    async (completion) => {
      const pending = deferred<Renewal>();
      const renew = vi.fn(
        (_id: string, _signal: AbortSignal) => pending.promise,
      );
      const { socket, native, ticket, onError } = await admitted(renew);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(native.readyState).toBe(3);
      expect(renew.mock.calls[0]![1].aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(ticket).toHaveBeenCalledTimes(2);
      const replacement = NativeSocket.instances.at(-1)!;
      replacement.open();
      socket.acceptReady(Date.now() + 30_000, "replacement");
      if (completion === "resolve")
        pending.resolve({
          connectionId: id,
          leaseExpiresAt: Date.now() + 300_000,
        });
      else pending.reject(new Error("Late renewal rejection"));
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled();
      expect(replacement.readyState).toBe(1);
      expect(socket.send("current typing")).toBe(true);
    },
  );

  it.each(["offline", "dispose", "retry"] as const)(
    "aborts renewal on %s and ignores its delayed success",
    async (retirement) => {
      const pending = deferred<Renewal>();
      const renew = vi.fn(
        (_id: string, _signal: AbortSignal) => pending.promise,
      );
      const { socket, native } = await admitted(renew);
      await vi.advanceTimersByTimeAsync(29_000);
      if (retirement === "offline") {
        vi.stubGlobal("navigator", { onLine: false });
        window.dispatchEvent(new Event("offline"));
      } else if (retirement === "dispose") socket.dispose();
      else socket.retry();
      expect(renew.mock.calls[0]![1].aborted).toBe(true);
      pending.resolve({
        connectionId: id,
        leaseExpiresAt: Date.now() + 30_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(native.readyState).toBe(3);
      expect(socket.send("obsolete typing")).toBe(false);
    },
  );

  it.each([null, { connectionId: "other", leaseExpiresAt: 0 }])(
    "reconnects without rejecting owner access when renewal cannot identify the live socket (%j)",
    async (result) => {
      const renew = vi.fn(async () => result);
      const { native, ticket, onError } = await admitted(renew);
      await vi.advanceTimersByTimeAsync(29_001);
      expect(native.readyState).toBe(3);
      expect(ticket).toHaveBeenCalledTimes(2);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("stops permanently when renewal reports terminal access rejection", async () => {
    const renew = vi.fn(async () => {
      throw new Error("Revoked");
    });
    let dispose = () => {};
    const denied = vi.fn(() => dispose());
    const { socket, ticket } = await admitted(renew, denied);
    dispose = () => socket.dispose();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(denied).toHaveBeenCalledOnce();
    expect(ticket).toHaveBeenCalledOnce();
  });
});
