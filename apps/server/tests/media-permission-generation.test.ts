import { barrier } from "@tests/helpers/barrier";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mediaNetwork, mediaNetworkProbe } from "@tests/helpers/media-network";
import {
  grant,
  publishReady,
  token,
  joined,
  publication,
  request,
  setup,
  user,
} from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
afterEach(() => {
  mediaNetwork.resetHandlers();
  expect(mediaNetworkProbe.blocked).toBe(0);
  expect(mediaNetworkProbe.failures).toBe(0);
});
afterAll(async () => {
  // Terminate isolated actors before removing their provider interception.
  await abortAllDurableObjects();
  await mediaNetwork.disable();
});

/** A real owner grant, a joined room and a publication held at the synthetic SFU. */
async function heldPublication(isPrivate = false) {
  const s = setup();
  const owner = env.SERVER_DO.getByName(s.scope.owner.id);
  expect(
    await owner.initialize({
      serverId: s.scope.owner.id,
      ownerId: s.principal.userId,
      name: "Permission generation",
    }),
  ).toMatchObject({ kind: "initialized" });
  expect(
    await owner.createChannel(s.principal, {
      channelId: s.scope.channelId,
      name: "Voice",
      private: isPrivate,
      kind: "media",
      expectedVersion: 1,
    }),
  ).toMatchObject({ kind: "changed", version: 2 });
  const initial = await owner.authorizeMedia(s.principal, {
    channelId: s.scope.channelId,
  });
  if (initial.kind !== "media_authorized")
    throw new Error("Expected the owner media grant.");
  const accepted = joined(
    await s.account.join(s.principal, initial.authorization, request(s.scope)),
  );
  const gate = barrier();
  s.fake.publishGate = gate.promise;
  const publishing = s.media.publish(
    s.principal,
    initial.authorization,
    publication(accepted.handle),
  );
  await expect
    .poll(() => s.fake.calls.some((call) => call.path.endsWith("/tracks/new")))
    .toBe(true);
  return { s, owner, initial, accepted, gate, publishing };
}
async function freshGrant(
  owner: ReturnType<typeof env.SERVER_DO.getByName>,
  s: Awaited<ReturnType<typeof heldPublication>>["s"],
) {
  const fresh = await owner.authorizeMedia(s.principal, {
    channelId: s.scope.channelId,
  });
  if (fresh.kind !== "media_authorized")
    throw new Error("Expected a fresh media grant.");
  return fresh.authorization;
}

describe("owner permission generation on real workerd actors", () => {
  it("keeps an older in-flight publication and account intent across a topic edit", async () => {
    const { s, owner, initial, accepted, gate, publishing } =
      await heldPublication();
    try {
      expect(
        await owner.updateChannel(s.principal, {
          channelId: s.scope.channelId,
          topic: "Only the topic changed",
          expectedVersion: 1,
        }),
      ).toMatchObject({ kind: "changed", version: 2 });
      const fresh = await freshGrant(owner, s);
      expect(fresh.permissionGeneration).toBe(
        initial.authorization.permissionGeneration,
      );
      expect(
        await s.media.heartbeat(s.principal, fresh, {
          handle: accepted.handle,
        }),
      ).toMatchObject({ kind: "heartbeat" });
    } finally {
      gate.release();
    }
    expect(await publishing).toMatchObject({
      kind: "negotiation",
      phase: "awaiting_apply",
    });
    expect(await s.account.status(s.principal)).toMatchObject({
      kind: "media_status",
      admission: { kind: "transfer_required" },
      generation: accepted.generation,
    });
  });

  it("finishes an older valid grant after a role change and retains the maximum observed generation", async () => {
    const { s, owner, initial, accepted, gate, publishing } =
      await heldPublication();
    try {
      const successor = user();
      const invite = await owner.createInvite(
        { ...s.principal, invitePolicy: "members" },
        { expiresAt: Date.now() + 60_000 },
      );
      if (invite.kind !== "invite_created")
        throw new Error("Fixture invitation failed.");
      expect(
        await owner.redeemInvite(successor, { token: invite.token }),
      ).toMatchObject({ kind: "joined", version: 3 });
      expect(
        await owner.transferOwnership(s.principal, {
          userId: successor.userId,
          expectedVersion: 3,
        }),
      ).toMatchObject({ kind: "changed", version: 4 });
      const fresh = await freshGrant(owner, s);
      expect(fresh).toMatchObject({
        permissionGeneration: initial.authorization.permissionGeneration + 1,
        canJoin: true,
        canModerate: false,
      });
      expect(
        await s.media.heartbeat(s.principal, fresh, {
          handle: accepted.handle,
        }),
      ).toMatchObject({ kind: "heartbeat" });
    } finally {
      gate.release();
    }
    expect(await publishing).toMatchObject({
      kind: "negotiation",
      phase: "awaiting_apply",
    });
    await runInDurableObject(s.media, (_, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT permission_generation FROM media_participants WHERE id=? AND generation=?",
            accepted.handle.participantId,
            accepted.handle.accountGeneration,
          )
          .one(),
      ).toEqual({
        permission_generation: initial.authorization.permissionGeneration + 1,
      });
    });
    await s.media.invalidate({
      room: s.scope,
      userIds: [s.principal.userId],
      permissionGeneration: initial.authorization.permissionGeneration + 1,
    });
    expect(await s.account.status(s.principal)).toMatchObject({
      kind: "media_status",
      admission: { kind: "transfer_required" },
    });
  });
  it("lets explicit access revocation win over a late provider result", async () => {
    const { s, owner, initial, accepted, gate, publishing } =
      await heldPublication(true);
    let invalidating: Promise<unknown> | undefined;
    try {
      expect(
        await owner.setChannelMember(s.principal, {
          channelId: s.scope.channelId,
          userId: s.principal.userId,
          allowed: false,
          expectedVersion: 1,
        }),
      ).toMatchObject({ kind: "changed" });
      invalidating = s.media.invalidate({
        room: s.scope,
        userIds: [s.principal.userId],
        permissionGeneration: initial.authorization.permissionGeneration + 1,
      });
      await expect
        .poll(() =>
          runInDurableObject(
            s.media,
            (_, state) =>
              state.storage.sql
                .exec<{ status: string }>(
                  "SELECT status FROM media_participants WHERE id=? AND generation=?",
                  accepted.handle.participantId,
                  accepted.handle.accountGeneration,
                )
                .one().status,
          ),
        )
        .toBe("closing");
    } finally {
      gate.release();
    }
    expect(await publishing).toMatchObject({
      kind: "participation_ended",
      reason: "permission_revoked",
    });
    await invalidating;
    expect(await s.account.status(s.principal)).toMatchObject({
      admission: {
        kind: expect.toBeOneOf(["available", "cleanup_pending"]),
      },
    });
  });

  it("ignores replayed invalidations against fresh permission generations and cancels removed rejoin intent", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope, 5),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle, ["microphone"], 5);
    expect(
      await s.media.invalidate({
        room: s.scope,
        userIds: [s.principal.userId],
        permissionGeneration: 1,
      }),
    ).toEqual({ kind: "closed" });
    expect(await s.account.status(s.principal)).toMatchObject({
      admission: { kind: "transfer_required" },
      generation: 1,
    });
    expect(
      await s.media.invalidate({
        room: s.scope,
        userIds: [s.principal.userId],
        permissionGeneration: 6,
      }),
    ).toEqual({ kind: "closed" });
    expect(await s.account.status(s.principal)).toMatchObject({
      admission: {
        kind: expect.toBeOneOf(["available", "cleanup_pending"]),
      },
      generation: 1,
    });
    expect(
      await s.account.resume(s.principal, grant(s.principal, s.scope, 7), {
        nextDeviceToken: token(),
        handle: accepted.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({
      kind: "participation_ended",
      reason: "permission_revoked",
    });
  });
});
