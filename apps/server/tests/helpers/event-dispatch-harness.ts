import { expect } from "vitest";
import {
  AccountEventFrameSchema,
  AccountEventOutcomeSchema,
  ACCOUNT_EVENTS_PING,
  type AccountEventFrame,
} from "@vaskel/contracts/account-events";
import type { ApplicationClient } from "@tests/helpers/application-harness";

export async function accountEventsTicket(client: ApplicationClient) {
  const response = await client.request("/api/account/events/ticket", {});
  expect(response.status).toBe(200);
  const result = AccountEventOutcomeSchema.parse(await response.json());
  if (result.kind !== "event_ticket") throw new Error(result.kind);
  return result;
}
export async function accountEventsSocket(response: Response) {
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
    "vaskel-account-events-v1",
  );
  const client = response.webSocket!;
  const frames: AccountEventFrame[] = [];
  const queued: AccountEventFrame[] = [];
  const waiting: {
    resolve: (frame: AccountEventFrame) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let failure: unknown;
  client.addEventListener("message", (event) => {
    try {
      const frame = AccountEventFrameSchema.parse(
        JSON.parse(String(event.data)),
      );
      frames.push(frame);
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(frame);
      else queued.push(frame);
    } catch (error) {
      failure = error;
      for (const waiter of waiting.splice(0)) waiter.reject(error);
    }
  });
  const next = () => {
    if (failure) return Promise.reject<AccountEventFrame>(failure);
    const frame = queued.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise<AccountEventFrame>((resolve, reject) =>
          waiting.push({ resolve, reject }),
        );
  };
  const closed = new Promise<CloseEvent>((resolve) =>
    client.addEventListener("close", resolve, { once: true }),
  );
  client.accept();
  const ready = await next();
  if (ready.type !== "ready") throw new Error("Missing account-events ready.");
  return {
    client,
    frames,
    next,
    closed,
    ready,
    async sync() {
      client.send(ACCOUNT_EVENTS_PING);
      while ((await next()).type !== "pong") {
        // Drain frames before the automatic pong. It does not await actor,
        // alarm or detached notification work.
      }
    },
    async close() {
      if (client.readyState !== WebSocket.CLOSED) client.close(1000);
      await closed;
    },
  };
}
export async function openAccountEvents(client: ApplicationClient) {
  const ticket = await accountEventsTicket(client);
  const stream = await accountEventsSocket(
    await client.request("/api/account/events", undefined, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `vaskel-account-events-v1, vaskel-ticket.${ticket.ticket}`,
      },
    }),
  );
  return stream;
}
