import { notificationOwner as setup } from "@tests/helpers/notification-owner";
import { principal } from "@tests/helpers/messaging-owner";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  messageEnvelope as command,
  acceptedMessage as receipt,
} from "@tests/helpers/messaging";
import type { NotificationMessageReference } from "@/server/notifications/protocol";
import { sendMessage } from "@/server/routes/message-send";
import { offerCommittedNotification } from "@/server/notifications/offers";
import { barrier } from "@tests/helpers/barrier";
import { observeSql } from "@tests/helpers/sql-observer";

it.each(["server", "conversation"] as const)(
  "%s returns private offer data only for a newly committed Send",
  async (kind) => {
    const h = await setup(kind);
    const sendCommand = {
      ...command(h.channelId),
      body: "Hello [](/mentions/bob)",
    };
    const observed = await runInDurableObject(h.owner, (instance, state) =>
      observeSql(state.storage.sql, () =>
        instance.send(
          principal("alice"),
          sendCommand,
          undefined,
          "Alice Captured",
        ),
      ),
    );
    const result = observed.value;
    const sent = receipt(result.outcome);
    // The initial audience has only room/author bindings. Later hint checks also
    // bind their candidate IDs and must remain separate from this shared read.
    expect(
      observed.statements.filter(
        ({ query, bindings }) =>
          query.startsWith('select "user_id" from "members"') &&
          bindings.length === 3 &&
          bindings[0] === h.channelId,
      ),
    ).toHaveLength(1);
    expect(result.notification?.recipients.sort()).toEqual(
      kind === "server" ? ["bob", "carol"] : ["bob"],
    );
    expect(result.notification?.reference).toMatchObject({
      messageId: sent.messageId,
      senderLabel: "Alice Captured",
      owner: { kind, id: h.id },
    });
    expect(result.notification?.deadline).toBeGreaterThan(Date.now());
    expect(
      await h.owner.send(principal("alice"), sendCommand, undefined, "Renamed"),
    ).toEqual({
      outcome: { kind: "accepted", receipt: sent },
      notification: null,
    });
    expect(
      await h.owner.send(principal("outsider"), {
        ...command(h.channelId),
        body: "Unauthorized",
      }),
    ).toEqual({ outcome: { kind: "forbidden" }, notification: null });
    expect(
      await h.owner.edit(principal("alice"), {
        ...command(h.channelId),
        messageId: sent.messageId,
        expectedVersion: 1,
        body: "Edited",
      }),
    ).not.toHaveProperty("notification");
    expect(
      await h.owner.react(principal("bob"), {
        ...command(h.channelId),
        messageId: sent.messageId,
        emoji: "👍",
        on: true,
      }),
    ).not.toHaveProperty("notification");
  },
);

it("returns the Worker receipt while its bounded notification offers are still blocked", async () => {
  const h = await setup();
  await runInDurableObject(h.owner, async (_, state) => {
    for (let index = 0; index < 10; index++)
      state.storage.sql.exec(
        "INSERT INTO members(user_id,role) VALUES (?,'member')",
        `reader-${index}`,
      );
  });
  const execution = createExecutionContext();
  const blocked = barrier();
  const started = barrier();
  const native = env.NOTIFICATION_DO.getByName.bind(env.NOTIFICATION_DO);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  let active = 0,
    peak = 0,
    completed = 0;
  vi.spyOn(env.NOTIFICATION_DO, "getByName").mockImplementation((accountId) => {
    const stub = native(accountId);
    vi.spyOn(stub, "offerCommittedMessage").mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      if (active === 8) started.release();
      await blocked.promise;
      active--;
      completed++;
    });
    return stub;
  });
  try {
    const result = await sendMessage({
      env,
      waitUntil: (work) => execution.waitUntil(work),
      target: { owner: { kind: "server", id: h.id }, stub: h.owner },
      principal: principal("alice"),
      command: { ...command(h.channelId), body: "Deferred offers" },
      source: async () => null,
      refreshPrincipal: async () => principal("alice"),
    });
    expect(result).toEqual({ kind: "accepted", receipt: receipt(result) });
    await started.promise;
    expect(completed).toBe(0);
    expect(peak).toBe(8);
    blocked.release();
    await waitOnExecutionContext(execution);
    expect(completed).toBe(12);
    expect(peak).toBe(8);
  } finally {
    blocked.release();
    await waitOnExecutionContext(execution);
  }
});

it("persists the actual owner offer in the recipient actor without consulting D1", async () => {
  const accountId = crypto.randomUUID();
  const id = crypto.randomUUID();
  const owner = env.CONVERSATION_DO.getByName(id);
  await owner.initialize({
    conversationId: id,
    participantIds: ["alice", accountId],
  });
  const actor = env.NOTIFICATION_DO.getByName(accountId);
  const status = await actor.status(principal(accountId));
  if (status.kind !== "notification_state") throw new Error(status.kind);
  const { createVapidKeys } = await import("@/server/notifications/web-push");
  const key = await createVapidKeys();
  const enabled = await actor.command(principal(accountId), {
    kind: "enable",
    language: "en",
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedRevision: status.state.revision,
    deviceId: crypto.randomUUID(),
    label: "Fixture browser",
    subscription: {
      endpoint: "https://fcm.googleapis.com/fcm/send/source-fixture",
      keys: { p256dh: key.publicKey, auth: "AQEBAQEBAQEBAQEBAQEBAQ" },
    },
  });
  expect(enabled.kind).toBe("notification_updated");
  const execution = createExecutionContext();
  const identity = vi
    .spyOn(env.IDENTITY_DB, "prepare")
    .mockImplementation(() => {
      throw new Error("D1 unavailable");
    });
  try {
    receipt(
      await sendMessage({
        env,
        waitUntil: (work) => execution.waitUntil(work),
        target: { owner: { kind: "conversation", id }, stub: owner },
        principal: principal("alice"),
        command: { ...command(id), body: "Offline reach" },
        senderLabel: "Alice",
        source: async () => null,
        refreshPrincipal: async () => principal("alice"),
      }),
    );
    await waitOnExecutionContext(execution);
    expect(identity).not.toHaveBeenCalled();
  } finally {
    identity.mockRestore();
  }
  const references = await runInDurableObject(actor, async (_, state) => {
    const row = state.storage.sql
      .exec<{ references_json: string; due_at: number }>(
        "SELECT references_json,due_at FROM notification_pending",
      )
      .one();
    expect(row.due_at).toBeGreaterThan(Date.now());
    return JSON.parse(row.references_json) as NotificationMessageReference[];
  });
  expect(references).toHaveLength(1);
  expect(references[0]).toMatchObject({
    senderLabel: "Alice",
    owner: { kind: "conversation", id },
  });
  expect(
    await owner.selectNotificationMessage(accountId, references, {
      directOnly: true,
      includeText: true,
    }),
  ).toMatchObject({ trigger: "direct", text: "Offline reach" });
});

it("continues after a failed recipient and recovers the receipt without repeating offers", async () => {
  const h = await setup();
  const native = env.NOTIFICATION_DO.getByName.bind(env.NOTIFICATION_DO);
  const attempted: string[] = [];
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(env.NOTIFICATION_DO, "getByName").mockImplementation((accountId) => {
    const stub = native(accountId);
    const offer = stub.offerCommittedMessage;
    vi.spyOn(stub, "offerCommittedMessage").mockImplementation(
      async (reference) => {
        attempted.push(accountId);
        if (accountId === "bob") throw new Error("private failure details");
        await offer(reference);
      },
    );
    return stub;
  });
  const sendCommand = { ...command(h.channelId), body: "Committed once" };
  const send = async () => {
    const execution = createExecutionContext();
    const result = await sendMessage({
      env,
      waitUntil: (work) => execution.waitUntil(work),
      target: { owner: { kind: "server", id: h.id }, stub: h.owner },
      principal: principal("alice"),
      command: sendCommand,
      source: async () => null,
      refreshPrincipal: async () => principal("alice"),
    });
    expect(result).not.toHaveProperty("notification");
    await waitOnExecutionContext(execution);
    return receipt(result);
  };
  const committed = await send();
  expect(await send()).toEqual(committed);
  expect(attempted.toSorted()).toEqual(["bob", "carol"]);
  expect(diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "notification_offer_failed",
      processed: 2,
      failed: 1,
    }),
  );
  expect(JSON.stringify(diagnostics.mock.calls)).not.toContain(
    "private failure details",
  );
});

it("does not restart an expired owner budget when the Worker receives the offer", async () => {
  const h = await setup();
  const result = await h.owner.send(principal("alice"), {
    ...command(h.channelId),
    body: "Budget already spent",
  });
  receipt(result.outcome);
  const offer = result.notification;
  if (!offer) throw new Error("Fixture must produce an offer");
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  vi.spyOn(Date, "now").mockReturnValue(offer.deadline);
  const namespace = vi.spyOn(env.NOTIFICATION_DO, "getByName");
  const diagnostics = vi.spyOn(console, "warn").mockImplementation(() => {});
  await offerCommittedNotification(env, offer);
  expect(namespace).not.toHaveBeenCalled();
  expect(diagnostics).toHaveBeenCalledWith(
    expect.objectContaining({
      event: "notification_offer_failed",
      processed: offer.recipients.length,
      failed: offer.recipients.length,
    }),
  );
});
