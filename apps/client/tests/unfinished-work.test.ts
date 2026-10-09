import { deferred } from "@tests/shared/deferred";
import { createMemoryHistory } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageWork } from "@/client/features/chat/message-work";
import { UnfinishedWorkGuard } from "@/client/features/chat/unfinished-work";

const source = "/servers/server-a/channels/general";
const destination = "/conversations/conversation-b";

beforeEach(() => {
  // TanStack History runs browser blockers only when a document is present.
  vi.stubGlobal("document", {});
});
afterEach(() => vi.unstubAllGlobals());

function navigation() {
  const guard = new UnfinishedWorkGuard();
  const history = createMemoryHistory({ initialEntries: [source] });
  history.block({
    blockerFn: ({ currentLocation, nextLocation }) =>
      guard.blockNavigation(currentLocation.pathname, nextLocation.pathname),
    enableBeforeUnload: guard.hasWork,
  });
  return { guard, history };
}

describe("unfinished message-edit navigation", () => {
  it("keeps the conversation for Stay, accepts confirmed abandonment, and permits its local search", async () => {
    const { guard, history } = navigation();
    const editor = guard.register();
    editor.update("draft");

    history.push(`${source}?q=日本語#message`);
    await vi.waitFor(() => expect(history.location.search).toBe("?q=日本語"));
    expect(guard.getSnapshot()).toBeNull();
    history.push(destination);
    expect(guard.getSnapshot()).not.toBeNull();
    guard.keep();
    await Promise.resolve();
    expect(history.location.pathname).toBe(source);
    expect(guard.hasWork()).toBe(true);

    history.push(destination);
    guard.abandon();
    await vi.waitFor(() => expect(history.location.pathname).toBe(destination));
    // Only the actual owner unmount retires the work after a navigation commits.
    editor.release();
    expect(guard.hasWork()).toBe(false);
  });

  it("keeps the same decision open when a mutation becomes uncertain and rejects a competing navigation", async () => {
    const guard = new UnfinishedWorkGuard();
    const editor = guard.register();
    editor.update("sending");
    const first = guard.blockNavigation(source, destination);
    const resolved = vi.fn();
    void first.then(resolved);
    expect(guard.getSnapshot()).toBe("sending");

    editor.update("uncertain");
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();
    expect(guard.getSnapshot()).toBe("uncertain");
    await expect(
      guard.blockNavigation(source, "/settings/account"),
    ).resolves.toBe(true);
    guard.keep();
    await expect(first).resolves.toBe(true);
    expect(guard.hasWork()).toBe(true);

    const confirmed = guard.blockNavigation(source, destination);
    guard.abandon();
    await expect(confirmed).resolves.toBe(false);
    // Confirmation never changes or retries the conversation-owned command.
    expect(guard.hasWork()).toBe(true);
  });

  it("continues a paused navigation after all already-running row mutations finish", async () => {
    const { guard, history } = navigation();
    const work = new MessageWork();
    const conversation = guard.register();
    const unsubscribe = work.subscribe(() =>
      conversation.update(work.status()),
    );
    const first = deferred<void>();
    const second = deferred<void>();
    const facts = { channelId: "general", version: 1, attachments: [] };
    work.beginEdit("first", { body: "First edit", mentions: [] });
    work.beginEdit("second", { body: "Second edit", mentions: [] });
    const firstSubmit = work.submit(
      { ...facts, id: "first" },
      () => first.promise,
    );
    const secondSubmit = work.submit(
      { ...facts, id: "second" },
      () => second.promise,
    );
    history.replace(destination);
    expect(guard.getSnapshot()).toBe("sending");

    first.resolve();
    await firstSubmit;
    expect(history.location.pathname).toBe(source);
    expect(guard.getSnapshot()).toBe("sending");

    second.resolve();
    await secondSubmit;
    await vi.waitFor(() => expect(history.location.pathname).toBe(destination));
    expect(guard.getSnapshot()).toBeNull();
    expect(guard.hasWork()).toBe(false);
    unsubscribe();
    conversation.release();
  });

  it("cancels stale navigation on owner or account retirement and ignores late updates", async () => {
    const { guard, history } = navigation();
    const revokedEditor = guard.register();
    revokedEditor.update("uncertain");
    history.push(destination);
    revokedEditor.release();
    guard.abandon();
    await Promise.resolve();
    expect(history.location.pathname).toBe(source);
    revokedEditor.update("draft");
    expect(guard.hasWork()).toBe(false);

    const oldAccount = guard.register();
    oldAccount.update("sending");
    history.push(destination);
    guard.retire();
    oldAccount.update("uncertain");
    guard.abandon();
    await Promise.resolve();
    expect(history.location.pathname).toBe(source);
    expect(guard.hasWork()).toBe(false);
    expect(guard.getSnapshot()).toBeNull();

    // React's setup/cleanup replay may register a fresh lifetime on the same guard.
    const fresh = guard.register();
    fresh.update("draft");
    oldAccount.update(null);
    oldAccount.release();
    expect(guard.hasWork()).toBe(true);
    history.push(destination);
    expect(guard.getSnapshot()).not.toBeNull();
    const replacement = guard.register();
    replacement.update("uncertain");
    fresh.update(null);
    fresh.release();
    guard.abandon();
    await Promise.resolve();
    expect(history.location.pathname).toBe(source);
    expect(guard.hasWork()).toBe(true);
    history.push(destination);
    expect(guard.getSnapshot()).toBe("uncertain");
    guard.keep();
    replacement.release();
  });
});
