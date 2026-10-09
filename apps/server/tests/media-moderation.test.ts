import {
  moderationTarget,
  user,
  grant,
  token,
  request,
  setup,
  joined,
  publication,
  publishReady,
} from "@tests/helpers/media-room";
import { abortAllDurableObjects } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MediaOutcomeSchema } from "@vaskel/contracts/media";
import { mediaNetwork } from "@tests/helpers/media-network";

beforeAll(async () => {
  await mediaNetwork.enable();
});
afterEach(() => {
  mediaNetwork.resetHandlers();
});
afterAll(async () => {
  // Terminate isolated actors before removing their provider interception.
  await abortAllDurableObjects();
  await mediaNetwork.disable();
});

describe("media moderation forwarding and participation on native actors", () => {
  it("enforces sticky server mute through refresh and only reopens microphone publication after authorized unmute", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle, [
      "microphone",
      "camera",
      "screen_video",
      "screen_audio",
    ]);
    const snapshot = MediaOutcomeSchema.parse(
      await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
      }),
    );
    if (snapshot.kind !== "media_snapshot")
      throw new Error("Expected snapshot");
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
        userId: s.principal.userId,
        action: "mute",
        enabled: true,
        commandId: crypto.randomUUID(),
        ...moderationTarget(snapshot.snapshot, s.principal.userId),
      }),
    ).toMatchObject({ kind: "moderated", cleanupPending: false });
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle),
      ),
    ).toEqual({ kind: "action_restricted", restriction: "mute" });
    const refreshed = joined(
      await s.account.resume(s.principal, grant(s.principal, s.scope), {
        nextDeviceToken: token(),
        handle: accepted.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    );
    expect(refreshed.snapshot.participants[0]?.muted).toBe(true);
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(refreshed.handle),
      ),
    ).toEqual({ kind: "action_restricted", restriction: "mute" });
    const current = MediaOutcomeSchema.parse(
      await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
      }),
    );
    if (current.kind !== "media_snapshot") throw new Error("Expected snapshot");
    expect(
      await s.media.moderate(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
        userId: s.principal.userId,
        action: "mute",
        enabled: false,
        commandId: crypto.randomUUID(),
        ...moderationTarget(current.snapshot, s.principal.userId),
      }),
    ).toMatchObject({ kind: "moderated" });
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(refreshed.handle),
      ),
    ).toMatchObject({ kind: "negotiation" });
  });
  it("forces deafen and screen revocation on forwarding and clears kicked account rejoin intent", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const pubs = await publishReady(s, accepted.handle, [
      "microphone",
      "camera",
      "screen_video",
      "screen_audio",
    ]);
    const other = user(),
      account = env.ACCOUNT_MEDIA.getByName(other.userId);
    const receiver = joined(
      await account.join(other, grant(other, s.scope), request(s.scope)),
    );
    const subscriptions = {
      handle: receiver.handle,
      operationId: crypto.randomUUID(),
      issuedAt: Date.now(),
      expectedSessionVersion: 0,
      publicationIds: pubs.publications.map((pub) => pub.id),
    };
    const subscribed = MediaOutcomeSchema.parse(
      await s.media.subscribe(other, grant(other, s.scope), subscriptions),
    );
    if (subscribed.kind !== "negotiation") throw new Error("Expected offer");
    await s.media.answer(other, grant(other, s.scope), {
      handle: receiver.handle,
      operationId: subscribed.operationId,
      expectedSessionVersion: 1,
      sessionDescription: { type: "answer", sdp: "v=0\r\n" },
    });
    async function command(
      userId: string,
      action: "deafen" | "screen_revoke" | "remove",
    ) {
      const snapshot = MediaOutcomeSchema.parse(
        await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
          room: s.scope,
        }),
      );
      if (snapshot.kind !== "media_snapshot")
        throw new Error("Expected snapshot");
      return s.media.moderate(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
        userId,
        action,
        enabled: true,
        commandId: crypto.randomUUID(),
        ...moderationTarget(snapshot.snapshot, userId),
      });
    }
    expect(await command(other.userId, "deafen")).toMatchObject({
      kind: "moderated",
      cleanupPending: false,
    });
    expect(
      await s.media.subscribe(other, grant(other, s.scope), {
        ...subscriptions,
        operationId: crypto.randomUUID(),
        expectedSessionVersion: 1,
      }),
    ).toEqual({ kind: "action_restricted", restriction: "deafen" });
    expect(await command(s.principal.userId, "screen_revoke")).toMatchObject({
      kind: "moderated",
      cleanupPending: false,
    });
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle, ["screen_video"], 1),
      ),
    ).toEqual({ kind: "action_restricted", restriction: "screen" });
    const snapshot = MediaOutcomeSchema.parse(
      await s.media.snapshot(s.principal, grant(s.principal, s.scope), {
        room: s.scope,
      }),
    );
    if (snapshot.kind !== "media_snapshot")
      throw new Error("Expected snapshot");
    expect(
      snapshot.snapshot.participants
        .find((p) => p.id === s.principal.userId)
        ?.publications.map((pub) => pub.source)
        .sort(),
    ).toEqual(["camera", "microphone"]);
    expect(await command(other.userId, "remove")).toMatchObject({
      kind: "moderated",
      cleanupPending: false,
    });
    expect(await account.status(other)).toMatchObject({
      admission: {
        kind: expect.toBeOneOf(["available", "cleanup_pending"]),
      },
    });
    expect(
      await account.resume(other, grant(other, s.scope), {
        nextDeviceToken: token(),
        handle: receiver.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "participation_ended", reason: "removed" });
  });
});
