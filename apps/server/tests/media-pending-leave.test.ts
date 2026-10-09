import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LeaveMediaRequestSchema,
  type AccountMediaOutcome,
  type PendingMediaCommand,
} from "@vaskel/contracts/media";
import { mediaRoomKey } from "@/server/media/authorization";
import {
  blockProviderSession,
  forwardingCount,
  providerSession,
  snapshot,
} from "@tests/helpers/media-lifecycle";
import { mediaNetwork, mediaNetworkProbe } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  publishReady,
  request,
  room,
  setup,
  token,
} from "@tests/helpers/media-room";

beforeAll(() => {
  expect(env.REALTIME_APP_ID === "fixture-app").toBe(true);
  expect(env.REALTIME_APP_SECRET === "fixture-secret").toBe(true);
  mediaNetwork.enable();
});
afterEach(() => {
  mediaNetwork.resetHandlers();
  expect(mediaNetworkProbe.blocked).toBe(0);
  expect(mediaNetworkProbe.failures).toBe(0);
  expect(mediaNetworkProbe.interceptorFailures).toBe(0);
});
afterAll(() => mediaNetwork.disable());

function leave(pending: PendingMediaCommand) {
  return LeaveMediaRequestSchema.parse({
    pending,
    commandId: crypto.randomUUID(),
    issuedAt: Date.now(),
  });
}

function begin(
  fixture: ReturnType<typeof setup>,
  pending: PendingMediaCommand,
) {
  return pending.path === "resume"
    ? fixture.account.resume(
        fixture.principal,
        grant(fixture.principal, pending.body.handle.room),
        pending.body,
      )
    : fixture.account[pending.path](
        fixture.principal,
        grant(fixture.principal, pending.body.room),
        pending.body,
      );
}

describe("Leave while an account command is pending", () => {
  it.each(["join", "resume", "transfer"] as const)(
    "fences a delayed %s before acceptance without allocating its destination",
    async (path) => {
      const fixture = setup();
      let pending: PendingMediaCommand;
      if (path === "join") {
        pending = { path, body: request(fixture.scope) };
      } else {
        const accepted = joined(
          await fixture.account.join(
            fixture.principal,
            grant(fixture.principal, fixture.scope),
            request(fixture.scope),
          ),
        );
        await publishReady(fixture, accepted.handle);
        if (path === "resume") {
          pending = {
            path,
            body: {
              handle: accepted.handle,
              nextDeviceToken: token(),
              commandId: crypto.randomUUID(),
              issuedAt: Date.now(),
            },
          };
        } else {
          // The confirmed Move belongs to another signed-in endpoint. Leave
          // must end the predecessor and retain the cancelling session's receipt.
          fixture.principal = {
            ...fixture.principal,
            sessionId: crypto.randomUUID(),
          };
          pending = { path, body: request(room(), accepted.generation) };
        }
      }
      const allocations = fixture.fake.sessions.size;
      const cancellation = leave(pending);
      const result = await fixture.account.leave(
        fixture.principal,
        cancellation,
      );
      expect(result).toMatchObject({ kind: "left", cleanupPending: false });
      expect(
        await fixture.account.leave(fixture.principal, cancellation),
      ).toEqual(result);
      expect(await begin(fixture, pending)).toMatchObject({
        kind: "stale_generation",
      });
      expect(await fixture.account.status(fixture.principal)).toMatchObject({
        admission: { kind: "available" },
      });
      expect((await snapshot(fixture)).participants).toEqual([]);
      expect(forwardingCount(fixture.fake)).toBe(0);
      expect(fixture.fake.sessions.size).toBe(allocations);
    },
  );

  it("cancels an accepted Resume while retaining its blocked predecessor cleanup", async () => {
    const fixture = setup();
    const accepted = joined(
      await fixture.account.join(
        fixture.principal,
        grant(fixture.principal, fixture.scope),
        request(fixture.scope),
      ),
    );
    await publishReady(fixture, accepted.handle);
    const pending: PendingMediaCommand = {
      path: "resume",
      body: {
        handle: accepted.handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      },
    };
    const gate = blockProviderSession(
      fixture.fake,
      await providerSession(fixture, accepted.handle),
    );
    const resuming = Promise.resolve(begin(fixture, pending));
    let leaving: Promise<AccountMediaOutcome> | undefined;
    try {
      await gate.wait();
      leaving = Promise.resolve(
        fixture.account.leave(fixture.principal, leave(pending)),
      );
      await expect
        .poll(() => fixture.account.status(fixture.principal))
        .toMatchObject({
          generation: 3,
          admission: { kind: "cleanup_pending" },
        });
      await runInDurableObject(fixture.account, (_instance, state) => {
        expect(
          state.storage.sql
            .exec<{ generation: number }>(
              "SELECT json_extract(participation, '$.cleanup.generation') AS generation FROM account_media",
            )
            .one().generation,
        ).toBe(accepted.generation);
      });
    } finally {
      gate.release();
      await Promise.all([resuming, leaving]);
    }
    expect(await resuming).toMatchObject({ kind: "stale_generation" });
    expect(await leaving).toMatchObject({
      kind: "left",
      cleanupPending: true,
    });
    await expect
      .poll(() => fixture.account.status(fixture.principal))
      .toMatchObject({
        admission: { kind: "available" },
      });
    expect((await snapshot(fixture)).participants).toEqual([]);
    expect(forwardingCount(fixture.fake)).toBe(0);
    expect(fixture.fake.sessions.size).toBe(1);
  });

  it("rejects unowned or superseded pending proofs without ending a different explicit claim", async () => {
    const fixture = setup();
    const abandoned: PendingMediaCommand = {
      path: "join",
      body: request(fixture.scope),
    };
    const acceptedCommand: PendingMediaCommand = {
      path: "join",
      body: request(fixture.scope),
    };
    const accepted = joined(await begin(fixture, acceptedCommand));
    // A different request won the exact generation predicted by the abandoned
    // Join. Generation arithmetic must not turn its pending token into authority.
    expect(
      await fixture.account.leave(fixture.principal, leave(abandoned)),
    ).toEqual({
      kind: "stale_generation",
      currentGeneration: accepted.generation,
    });
    expect(
      await fixture.account.leave(
        { ...fixture.principal, sessionId: crypto.randomUUID() },
        leave(acceptedCommand),
      ),
    ).toEqual({ kind: "forbidden" });
    expect(
      await fixture.account.leave(
        fixture.principal,
        leave({
          ...acceptedCommand,
          body: { ...acceptedCommand.body, deviceToken: token() },
        }),
      ),
    ).toEqual({ kind: "command_conflict" });
    expect(
      await fixture.media.heartbeat(
        fixture.principal,
        grant(fixture.principal, fixture.scope),
        { handle: accepted.handle },
      ),
    ).toMatchObject({ kind: "heartbeat" });

    const destination = room();
    const movedCommand: PendingMediaCommand = {
      path: "transfer",
      body: request(destination, accepted.generation),
    };
    const moved = joined(await begin(fixture, movedCommand));
    expect(
      await fixture.account.leave(fixture.principal, leave(acceptedCommand)),
    ).toEqual({
      kind: "stale_generation",
      currentGeneration: moved.generation,
    });
    const destinationRoom = env.MEDIA_ROOM.getByName(mediaRoomKey(destination));
    expect(
      await destinationRoom.heartbeat(
        fixture.principal,
        grant(fixture.principal, destination),
        { handle: moved.handle },
      ),
    ).toMatchObject({ kind: "heartbeat" });
    expect(
      await fixture.account.leave(fixture.principal, leave(movedCommand)),
    ).toMatchObject({ kind: "left", cleanupPending: false });
    expect(await fixture.account.status(fixture.principal)).toMatchObject({
      admission: { kind: "available" },
    });
  });
});
