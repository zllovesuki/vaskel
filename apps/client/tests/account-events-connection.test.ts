import { fetchRequest } from "@tests/helpers/http";
import { failureResponse } from "@tests/helpers/http";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_EVENTS_PING } from "@vaskel/contracts/account-events";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(
    readonly url: URL,
    readonly protocols: string[],
  ) {
    super();
    Socket.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== Socket.OPEN) throw new Error("Socket is not open");
    this.sent.push(data);
  }
  open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    queueMicrotask(() => {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    });
  }
  receive(frame: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: typeof frame === "string" ? frame : JSON.stringify(frame),
      }),
    );
  }
}
const ticket = "a".repeat(64);
let connectAccountEvents: typeof import("@/client/features/account-events/connection").connectAccountEvents;
let api: typeof import("@/client/api/client");
let activity: typeof import("@/client/api/activity");
let client: QueryClient;
let restoreAccess: () => void;
let fetchMock: ReturnType<typeof vi.fn>;
const disposals: (() => void)[] = [];
const flush = () => new Promise((resolve) => setImmediate(resolve));
function ticketResponse(
  status: "event_ticket" | "unauthenticated" = "event_ticket",
) {
  return status === "event_ticket"
    ? Response.json({
        kind: "event_ticket",
        ticket,
        expiresAt: Date.now() + 15_000,
        leaseExpiresAt: Date.now() + 900_000,
      })
    : failureResponse({ kind: "unauthenticated" }, { status: 401 });
}
async function connect(onRevoked = vi.fn()) {
  const status = vi.fn();
  const connection = connectAccountEvents({
    client,
    userId: "account",
    status,
    onRevoked,
    effects: {
      contentChanged: vi.fn(),
      resync: vi.fn(),
      presenceChanged: vi.fn(),
      callChanged: vi.fn(async () => {}),
      messageArrived: vi.fn(),
    },
  });
  disposals.push(() => connection.dispose());
  await vi.advanceTimersByTimeAsync(0);
  await flush();
  Socket.instances.at(-1)?.open();
  return { status, onRevoked, connection };
}
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("window", {
    location: { origin: "https://vaskel.test" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("location", {
    origin: "https://vaskel.test",
    protocol: "https:",
  });
  fetchMock = vi.fn(async (path: RequestInfo | URL) =>
    new URL(fetchRequest(path).url).pathname.endsWith("/events/ticket")
      ? ticketResponse()
      : failureResponse({ kind: "invalid_input" }, { status: 400 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  api = await import("@/client/api/client");
  ({ connectAccountEvents } =
    await import("@/client/features/account-events/connection"));
  activity = await import("@/client/api/activity");
  restoreAccess = api.installRequestAccess({
    begin: () => ({
      current: () => true,
      accountId: "account",
    }),
    failed: vi.fn(),
  });
  client = new QueryClient();
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  client.clear();
  restoreAccess();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account inbox socket", () => {
  it.each([false, true])(
    "resumes hidden metadata through socket visibility unless revoked (%s)",
    async (revoked) => {
      await connect();
      const key = api.membersKey("account", { kind: "server", id: "circle" });
      client.setQueryData(key, 0);
      const fetcher = vi.fn(async () => 1);
      const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn: fetcher,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
      });
      const stop = observer.subscribe(() => {});
      try {
        Object.defineProperty(document, "visibilityState", {
          value: "hidden",
          configurable: true,
        });
        Socket.instances[0]!.receive({
          type: "directory",
          owner: { kind: "server", id: "circle" },
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).not.toHaveBeenCalled();
        if (revoked) Socket.instances[0]!.receive({ type: "revoked" });
        Object.defineProperty(document, "visibilityState", {
          value: "visible",
          configurable: true,
        });
        const visible = vi
          .mocked(document.addEventListener)
          .mock.calls.find(
            ([type]) => type === "visibilitychange",
          )?.[1] as () => void;
        visible();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(revoked ? 0 : 1);
      } finally {
        stop();
      }
    },
  );
  it("takes a ticket, upgrades with the inbox subprotocols and resyncs on ready", async () => {
    client.setQueryData(api.directoryKey("account"), {
      pages: [],
      pageParams: [],
    });
    client.setQueryData(activity.accountActivityKey("account"), {
      pages: [],
      pageParams: [],
    });
    const { status } = await connect();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchRequest(fetchMock.mock.calls[0]![0]).url).toContain(
      "/api/account/events/ticket",
    );
    const socket = Socket.instances[0]!;
    expect(socket.url.toString()).toBe("wss://vaskel.test/api/account/events");
    expect(socket.protocols).toEqual([
      "vaskel-account-events-v1",
      `vaskel-ticket.${ticket}`,
    ]);
    socket.receive({
      type: "ready",
      leaseExpiresAt: Date.now() + 900_000,
      resync: true,
    });
    expect(status).toHaveBeenLastCalledWith("connected");
    expect(
      client.getQueryState(api.directoryKey("account"))?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(activity.accountActivityKey("account"))
        ?.isInvalidated,
    ).toBe(true);
    socket.receive({ type: "pong" });
    expect(socket.readyState).toBe(1);
  });
  it("pings every 25 seconds while open and stops once the socket closes", async () => {
    await connect();
    const socket = Socket.instances[0]!;
    socket.receive({
      type: "ready",
      leaseExpiresAt: Date.now() + 900_000,
      resync: true,
    });
    vi.advanceTimersByTime(25_000);
    expect(socket.sent).toEqual([ACCOUNT_EVENTS_PING]);
    socket.receive({ type: "pong" });
    vi.advanceTimersByTime(25_000);
    expect(socket.sent).toHaveLength(2);
    socket.close();
    await flush();
    vi.advanceTimersByTime(25_000);
    expect(socket.sent).toHaveLength(2);
  });
  it("reconnects with a fresh ticket shortly before the lease ends", async () => {
    await connect();
    const first = Socket.instances[0]!;
    first.receive({
      type: "ready",
      leaseExpiresAt: Date.now() + 60_000,
      resync: true,
    });
    vi.advanceTimersByTime(25_000);
    first.receive({ type: "pong" });
    vi.advanceTimersByTime(28_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2_000);
    await flush();
    expect(first.readyState).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Socket.instances).toHaveLength(2);
  });
  it("stops for good when the actor revokes the session", async () => {
    const { status, onRevoked } = await connect();
    Socket.instances[0]!.receive({ type: "revoked" });
    expect(status).toHaveBeenLastCalledWith("revoked");
    expect(onRevoked).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Socket.instances).toHaveLength(1);
  });
  it("closes on an invalid frame and reconnects with backoff, and treats an unauthenticated ticket as revoked", async () => {
    const { status, onRevoked } = await connect();
    const socket = Socket.instances[0]!;
    socket.receive("{not json");
    // Native close is asynchronous: late frames must be fenced before its
    // close event lets PartySocket detach this transport's listeners.
    expect(socket.readyState).toBe(2);
    socket.receive({ type: "revoked" });
    socket.receive({
      type: "ready",
      leaseExpiresAt: Date.now() + 900_000,
      resync: true,
    });
    expect(onRevoked).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalledWith("connected");
    await flush();
    expect(socket.readyState).toBe(3);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
    vi.advanceTimersByTime(1_200);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Socket.instances).toHaveLength(2);
    fetchMock.mockImplementation(async () => ticketResponse("unauthenticated"));
    const second = await connect(onRevoked);
    expect(second.status).toHaveBeenLastCalledWith("revoked");
    expect(onRevoked).toHaveBeenCalledTimes(1);
  });

  it("obtains a fresh ticket when an OPEN socket stops returning frames", async () => {
    const { status } = await connect();
    const first = Socket.instances[0]!;
    first.receive({
      type: "ready",
      leaseExpiresAt: Date.now() + 900_000,
      resync: true,
    });
    await vi.advanceTimersByTimeAsync(37_000);
    expect(first.sent).toEqual([ACCOUNT_EVENTS_PING]);
    expect(first.readyState).toBe(3);
    expect(Socket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
  });

  it("checks elapsed deadlines when a suspended tab returns before its timers run", async () => {
    await connect();
    const first = Socket.instances[0]!;
    first.receive({
      type: "ready",
      leaseExpiresAt: Date.now() + 900_000,
      resync: true,
    });
    vi.setSystemTime(Date.now() + 120_000);
    const visible = vi
      .mocked(document.addEventListener)
      .mock.calls.find(
        ([type]) => type === "visibilitychange",
      )?.[1] as () => void;
    visible();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(first.readyState).toBe(3);
    expect(Socket.instances).toHaveLength(2);
  });
});
