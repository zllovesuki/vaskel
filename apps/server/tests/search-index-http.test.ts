import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { RebuildSearchIndexesEventSchema } from "@vaskel/contracts/search";
import type { Principal } from "@/server/domain/principal";
import { MESSAGE_SEARCH_POLICY } from "@/server/actors/shared/message-search";
import {
  applicationHarness,
  type ApplicationClient,
} from "@tests/helpers/application-harness";

const path = "/api/operator/search-index/rebuild";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const decode = (body: string) =>
  body
    .split("\n\n")
    .filter((frame) => frame.includes("data: "))
    .map((frame) =>
      RebuildSearchIndexesEventSchema.parse(
        JSON.parse(frame.split("data: ")[1]!),
      ),
    );

async function seed(operator: ApplicationClient, count: number) {
  for (let index = 1; index <= count; index++) {
    const owner = env.SERVER_DO.getByName(id(index));
    await owner.initialize({
      serverId: id(index),
      name: "Search fixture",
      ownerId: operator.profile!.userId,
    });
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE owner_state SET search_policy='native-trigram-v1'",
      );
    });
  }
  await env.IDENTITY_DB.batch(
    Array.from({ length: count }, (_, index) =>
      env.IDENTITY_DB.prepare(
        "INSERT INTO resource_directory(id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?,'server','Fixture',?,'ready','fixture',1)",
      ).bind(id(index + 1), operator.profile!.userId),
    ),
  );
}

function intercept(
  rebuild: (name: string, invoke: () => Promise<unknown>) => Promise<unknown>,
) {
  const original = env.SERVER_DO.getByName.bind(env.SERVER_DO);
  return vi
    .spyOn(env.SERVER_DO, "getByName")
    .mockImplementation((name, options) => {
      const stub = original(name, options);
      return new Proxy(stub, {
        get(target, property) {
          if (property === "rebuildSearchIndex")
            return (principal: Principal & { isOperator: true }) =>
              rebuild(
                name,
                async () => await target.rebuildSearchIndex(principal),
              );
          return Reflect.get(target, property, target);
        },
      });
    });
}

it("authenticates and validates before opening a private SSE response", async () => {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  const server = await h.createServer(operator);
  const { member } = await h.registerMember(operator, server.owner.id);
  for (const [client, body, options, status] of [
    [h.anonymous, {}, {}, 401],
    [member, {}, {}, 403],
    [operator, {}, { origin: null }, 403],
    [operator, { unexpected: true }, {}, 400],
  ] as const) {
    const response = await client.request(path, body, options);
    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).not.toContain(
      "text/event-stream",
    );
  }
  const response = await operator.request(path, {});
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Content-Type")).toBe("text/event-stream");
  expect(decode(await response.text()).at(-1)).toEqual({
    type: "complete",
    rebuilt: 1,
    failed: 0,
    indexedMessages: 0,
  });
});

it("streams progress while sequentially traversing every directory page and both owner types", async () => {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  await seed(operator, 22);
  const conversation = env.CONVERSATION_DO.getByName(id(23));
  await conversation.initialize({
    conversationId: id(23),
    participantIds: [operator.profile!.userId, "reader"],
  });
  await env.IDENTITY_DB.prepare(
    "INSERT INTO resource_directory(id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?,'conversation','Fixture',?,'ready','fixture',1)",
  )
    .bind(id(23), operator.profile!.userId)
    .run();
  // Pending factories have no ready message owner to rebuild.
  await env.IDENTITY_DB.prepare(
    "INSERT INTO resource_directory(id,kind,name,creator_id,lifecycle,payload_hash,created_at) VALUES (?,'server','Pending',?,'pending','fixture',1)",
  )
    .bind(id(24), operator.profile!.userId)
    .run();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let active = 0;
  const calls: string[] = [];
  const spy = intercept(async (name, invoke) => {
    calls.push(name);
    expect(++active).toBe(1);
    try {
      if (name === id(1)) {
        started();
        await gate;
      }
      if (name === id(2)) throw new Error("synthetic private provider detail");
      return await invoke();
    } finally {
      active--;
    }
  });
  try {
    const response = await operator.request(path, {});
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(decode(first)[0]).toEqual({
      type: "progress",
      rebuilt: 0,
      failed: 0,
      indexedMessages: 0,
    });
    await firstStarted;
    expect(calls).toEqual([id(1)]);
    release();
    let body = first;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      body += new TextDecoder().decode(part.value);
    }
    const events = decode(body);
    expect(events.filter((event) => event.type === "progress")).toHaveLength(
      24,
    );
    expect(events.at(-1)).toEqual({
      type: "complete",
      rebuilt: 22,
      failed: 1,
      indexedMessages: 0,
    });
    expect(calls).toEqual(Array.from({ length: 22 }, (_, i) => id(i + 1)));
    expect(body).not.toContain("synthetic private");
    await runInDurableObject(conversation, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT search_policy FROM owner_state").one()
          .search_policy,
      ).toBe(MESSAGE_SEARCH_POLICY);
    });
  } finally {
    release();
    spy.mockRestore();
  }
});

it("stops dispatching after response cancellation while retaining the in-flight owner's rebuild", async () => {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  await seed(operator, 2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finished!: () => void;
  const firstFinished = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const firstOwner = env.SERVER_DO.getByName(id(1));
  const calls: string[] = [];
  const spy = intercept(async (name, invoke) => {
    calls.push(name);
    started();
    await gate;
    const result = await invoke();
    finished();
    return result;
  });
  try {
    const response = await operator.request(path, {});
    const reader = response.body!.getReader();
    await reader.read();
    await firstStarted;
    await reader.cancel();
    release();
    await firstFinished;
    await env.IDENTITY_DB.prepare("SELECT 1").first();
    expect(calls).toEqual([id(1)]);
    await runInDurableObject(firstOwner, (_instance, state) => {
      expect(
        state.storage.sql.exec("SELECT search_policy FROM owner_state").one()
          .search_policy,
      ).toBe(MESSAGE_SEARCH_POLICY);
    });
  } finally {
    release();
    spy.mockRestore();
  }
});

it("rechecks session authority between rebuilds and emits an explicit terminal denial", async () => {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  await seed(operator, 2);
  const calls: string[] = [];
  const spy = intercept(async (name, invoke) => {
    calls.push(name);
    const result = await invoke();
    await env.IDENTITY_DB.prepare("DELETE FROM identity_session WHERE userId=?")
      .bind(operator.profile!.userId)
      .run();
    return result;
  });
  try {
    const response = await operator.request(path, {});
    const events = decode(await response.text());
    expect(events.at(-1)).toEqual({ type: "error", kind: "unauthenticated" });
    expect(events.some((event) => event.type === "complete")).toBe(false);
    expect(calls).toEqual([id(1)]);
  } finally {
    spy.mockRestore();
  }
});

it("sanitizes failures after SSE headers instead of relying on Hono's global error handler", async () => {
  const h = applicationHarness();
  const operator = await h.bootstrap();
  const native = env.IDENTITY_DB.withSession.bind(env.IDENTITY_DB);
  const spy = vi
    .spyOn(env.IDENTITY_DB, "withSession")
    .mockImplementation((anchor) => {
      const session = native(anchor);
      const prepare = session.prepare.bind(session);
      session.prepare = (query) => {
        if (query.includes('from "resource_directory"'))
          throw new Error("synthetic private directory detail");
        return prepare(query);
      };
      return session;
    });
  try {
    const response = await operator.request(path, {});
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(decode(body).at(-1)).toEqual({ type: "error", kind: "unavailable" });
    expect(body).not.toContain("synthetic private");
  } finally {
    spy.mockRestore();
  }
});
