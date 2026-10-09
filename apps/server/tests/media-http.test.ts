import { readHttpFailure } from "@tests/helpers/http";
import { token, request as join } from "@tests/helpers/media-room";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  MediaOutcomeSchema,
  ConsumerMediaOutcomeSchema,
  type MediaHandle,
  type MediaOutcome,
  type MediaRoomRef,
} from "@vaskel/contracts/media";
import { MediaConfigurationSchema } from "@vaskel/contracts/media-http";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { createMediaSfu } from "@tests/fixtures/media-sfu";
import {
  applicationHarness,
  decodeApplicationResponse,
  type ApplicationClient,
} from "@tests/helpers/application-harness";
import { mediaNetwork, useMediaSfu } from "@tests/helpers/media-network";

beforeAll(() => mediaNetwork.enable());
afterEach(() => mediaNetwork.resetHandlers());
afterAll(() => mediaNetwork.disable());

function leave(handle: MediaHandle) {
  return { handle, commandId: crypto.randomUUID(), issuedAt: Date.now() };
}
function publish(handle: MediaHandle, expectedSessionVersion = 0) {
  return {
    handle,
    operationId: crypto.randomUUID(),
    issuedAt: Date.now(),
    expectedSessionVersion,
    sessionDescription: {
      type: "offer",
      sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:0\r\n",
    },
    tracks: [{ source: "microphone", mid: "0" }],
  };
}
async function outcome(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return decodeApplicationResponse(response, MediaOutcomeSchema);
}
function kind<Kind extends MediaOutcome["kind"]>(
  value: MediaOutcome,
  expected: Kind,
): Extract<MediaOutcome, { kind: Kind }> {
  if (value.kind !== expected)
    throw new Error(`Expected ${expected}, received ${value.kind}.`);
  return value as Extract<MediaOutcome, { kind: Kind }>;
}
async function setup() {
  const fake = createMediaSfu();
  useMediaSfu(fake);
  const h = applicationHarness();
  const operator = await h.bootstrap();
  const server = await h.createServer(operator, "HTTP media");
  async function channel(isPrivate = false): Promise<MediaRoomRef> {
    const directory = await decodeApplicationResponse(
      await operator.request(server.path),
      DirectoryOutcomeSchema,
    );
    if (directory.kind !== "directory")
      throw new Error("Fixture server directory failed.");
    const channelId = crypto.randomUUID();
    const created = await decodeApplicationResponse(
      await operator.request(`/api/servers/${server.owner.id}/channels`, {
        channelId,
        name: "Voice",
        kind: "media",
        private: isPrivate,
        expectedVersion: directory.version,
      }),
      AdministrationOutcomeSchema,
    );
    expect(created.kind).toBe("changed");
    return { owner: server.owner, channelId };
  }
  return { h, operator, server, channel, fake };
}
async function media(client: ApplicationClient, path: string, body?: unknown) {
  return client.request(`/api/media/${path}`, body);
}

describe("media HTTP with real identity, directory and owning actors", () => {
  it("rejects anonymous, cross-origin, malformed and oversized commands before allocating media", async () => {
    const { h, operator, server, channel, fake } = await setup();
    const room = await channel();
    const command = join(room);
    expect(
      await readHttpFailure(await media(h.anonymous, "join", command)),
    ).toMatchObject({ code: "UNAUTHENTICATED" });
    for (const origin of [null, "https://elsewhere.invalid"]) {
      const response = await operator.request("/api/media/join", command, {
        origin,
      });
      expect(response.status).toBe(403);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "ORIGIN_REJECTED",
      });
    }
    expect(
      await readHttpFailure(
        await operator.request("/api/media/join", undefined, { rawBody: "{" }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST" });
    for (const [body, code] of [
      [{ ...command, expectedGeneration: "0" }, "BAD_REQUEST"],
      [{ ...command, authorization: { canJoin: true } }, "BAD_REQUEST"],
      [
        {
          ...command,
          room: { ...room, owner: { kind: "server", id: "not-a-uuid" } },
        },
        "INVALID_INPUT",
      ],
    ] as const) {
      expect(
        await readHttpFailure(await media(operator, "join", body)),
      ).toMatchObject({ code });
    }
    expect(
      await readHttpFailure(
        await operator.request("/api/media/join", undefined, {
          rawBody: " ".repeat(2 * 1024 * 1024 + 1),
        }),
      ),
    ).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(
      await readHttpFailure(
        await media(
          operator,
          "join",
          join({ owner: server.owner, channelId: server.channelId }),
        ),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await readHttpFailure(
        await media(
          operator,
          "join",
          join({ ...room, owner: { kind: "server", id: crypto.randomUUID() } }),
        ),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(await outcome(await media(operator, "status"))).toMatchObject({
      kind: "media_status",
      generation: 0,
      admission: { kind: "available" },
    });
    expect(fake.calls).toHaveLength(0);
    expect(fake.sessions.size).toBe(0);
  });

  it("produces schema-valid join, publish, ACK, snapshot and leave responses through HTTP", async () => {
    const { operator, channel, fake } = await setup();
    const room = await channel();
    const config = await media(operator, "config");
    expect(config.status).toBe(200);
    expect(
      await decodeApplicationResponse(config, MediaConfigurationSchema),
    ).toEqual({
      kind: "media_configuration",
      configured: true,
      maxParticipants: 16,
    });
    const joined = kind(
      await outcome(await media(operator, "join", join(room))),
      "joined",
    );
    expect(joined.snapshot.participants).toHaveLength(1);
    expect(fake.sessions.size).toBe(0);
    const command = publish(joined.handle, joined.producerVersion);
    const negotiation = kind(
      await outcome(await media(operator, "publish", command)),
      "negotiation",
    );
    expect(negotiation.phase).toBe("awaiting_apply");
    expect(negotiation.sessionDescription.type).toBe("answer");
    const beforeAck = kind(
      await outcome(await media(operator, "snapshot", { room })),
      "media_snapshot",
    );
    expect(beforeAck.snapshot.participants[0]?.publications).toHaveLength(0);
    const ack = {
      handle: joined.handle,
      operationId: negotiation.operationId,
      expectedSessionVersion: negotiation.sessionVersion,
    };
    const completed = kind(
      await outcome(await media(operator, "ack", ack)),
      "completed",
    );
    expect(await outcome(await media(operator, "ack", ack))).toEqual(completed);
    const snapshot = kind(
      await outcome(await media(operator, "snapshot", { room })),
      "media_snapshot",
    );
    expect(snapshot.snapshot.participants[0]?.publications).toEqual(
      negotiation.publications,
    );
    expect(snapshot.snapshot.participants[0]?.publications[0]?.source).toBe(
      "microphone",
    );
    expect(
      await readHttpFailure(
        await media(
          operator,
          "publish",
          publish(joined.handle, joined.producerVersion),
        ),
      ),
    ).toMatchObject({
      code: "STALE_VERSION",
      data: {
        kind: "stale_version",
        currentVersion: completed.sessionVersion,
      },
    });
    const safeStatus = kind(
      await outcome(await media(operator, "status")),
      "media_status",
    );
    expect("deviceToken" in safeStatus).toBe(false);
    expect(JSON.stringify(snapshot).includes(joined.handle.deviceToken)).toBe(
      false,
    );
    const left = kind(
      await outcome(await media(operator, "leave", leave(joined.handle))),
      "left",
    );
    expect(left.cleanupPending).toBe(false);
    const empty = kind(
      await outcome(await media(operator, "snapshot", { room })),
      "media_snapshot",
    );
    expect(empty.snapshot.participants).toHaveLength(0);
    expect(
      [...fake.sessions.values()].every((session) => session.tracks.size === 0),
    ).toBe(true);
    expect(await outcome(await media(operator, "status"))).toMatchObject({
      kind: "media_status",
      admission: { kind: "available" },
    });
  });

  it.each([false, true])(
    "requires full consumer completion maps through HTTP (renegotiation: %s), while producer completion omits them",
    async (renegotiationRequired) => {
      const { h, operator, server, channel, fake } = await setup();
      fake.remoteRequiresRenegotiation = renegotiationRequired;
      const room = await channel();
      const { member } = await h.registerMember(operator, server.owner.id);
      const publisher = kind(
        await outcome(await media(operator, "join", join(room))),
        "joined",
      );
      const listener = kind(
        await outcome(await media(member, "join", join(room))),
        "joined",
      );
      const published = kind(
        await outcome(
          await media(operator, "publish", publish(publisher.handle)),
        ),
        "negotiation",
      );
      const producer = kind(
        await outcome(
          await media(operator, "ack", {
            handle: publisher.handle,
            operationId: published.operationId,
            expectedSessionVersion: published.sessionVersion,
          }),
        ),
        "completed",
      );
      expect(producer).not.toHaveProperty("subscriptions");
      expect(ConsumerMediaOutcomeSchema.safeParse(producer).success).toBe(
        false,
      );
      const command = {
        handle: listener.handle,
        operationId: crypto.randomUUID(),
        issuedAt: Date.now(),
        expectedSessionVersion: listener.consumerVersion,
        publicationIds: published.publications.map(({ id }) => id),
      };
      let result = ConsumerMediaOutcomeSchema.parse(
        await outcome(await media(member, "subscribe", command)),
      );
      if (renegotiationRequired) {
        const offered = kind(result, "negotiation");
        const answer = {
          handle: listener.handle,
          operationId: offered.operationId,
          expectedSessionVersion: offered.sessionVersion,
          sessionDescription: { type: "answer", sdp: "v=0\r\n" },
        };
        result = ConsumerMediaOutcomeSchema.parse(
          await outcome(await media(member, "answer", answer)),
        );
        expect(await outcome(await media(member, "answer", answer))).toEqual(
          result,
        );
      }
      const completed = kind(result, "completed");
      expect(completed.subscriptions).toHaveLength(1);
      expect(completed.subscriptions![0]!.publication).toEqual(
        published.publications[0],
      );
      const emptyCommand = {
        ...command,
        operationId: crypto.randomUUID(),
        expectedSessionVersion: completed.sessionVersion,
        publicationIds: [],
      };
      const empty = kind(
        ConsumerMediaOutcomeSchema.parse(
          await outcome(await media(member, "subscribe", emptyCommand)),
        ),
        "completed",
      );
      expect(empty.subscriptions).toEqual([]);
      expect(
        await outcome(await media(member, "subscribe", emptyCommand)),
      ).toEqual(empty);
      await outcome(await media(member, "leave", leave(listener.handle)));
      await outcome(await media(operator, "leave", leave(publisher.handle)));
    },
  );

  it("requires explicit endpoint transfer, rotates resume capability and fences stale HTTP handles", async () => {
    const { h, operator, channel, fake } = await setup();
    const room = await channel();
    const first = kind(
      await outcome(await media(operator, "join", join(room))),
      "joined",
    );
    const otherEndpoint = h.client();
    otherEndpoint.cookie = operator.cookie;
    const competing = join(room, first.generation);
    const calls = fake.calls.length;
    expect(
      await readHttpFailure(await media(otherEndpoint, "join", competing)),
    ).toMatchObject({
      code: "TRANSFER_REQUIRED",
      data: {
        kind: "transfer_required",
        currentGeneration: first.generation,
        room,
      },
    });
    expect(fake.calls).toHaveLength(calls);
    const moved = kind(
      await outcome(await media(otherEndpoint, "transfer", competing)),
      "joined",
    );
    expect(moved.generation).toBe(first.generation + 1);
    expect(
      await readHttpFailure(
        await media(operator, "publish", publish(first.handle)),
      ),
    ).toMatchObject({ code: "STALE_GENERATION" });
    const unchangedResume = {
      ...leave(moved.handle),
      nextDeviceToken: moved.handle.deviceToken,
    };
    const beforeResume = fake.calls.length;
    expect(
      await readHttpFailure(
        await media(otherEndpoint, "resume", unchangedResume),
      ),
    ).toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.calls).toHaveLength(beforeResume);
    const resumed = kind(
      await outcome(
        await media(otherEndpoint, "resume", {
          ...leave(moved.handle),
          nextDeviceToken: token(),
        }),
      ),
      "joined",
    );
    expect(resumed.generation).toBe(moved.generation + 1);
    expect(resumed.handle.deviceToken === moved.handle.deviceToken).toBe(false);
    expect(
      await readHttpFailure(
        await media(otherEndpoint, "heartbeat", { handle: moved.handle }),
      ),
    ).toMatchObject({ code: "STALE_GENERATION" });
    expect(
      await readHttpFailure(
        await media(otherEndpoint, "leave", leave(moved.handle)),
      ),
    ).toMatchObject({ code: "STALE_GENERATION" });
    kind(
      await outcome(
        await media(otherEndpoint, "heartbeat", { handle: resumed.handle }),
      ),
      "heartbeat",
    );
    kind(
      await outcome(await media(otherEndpoint, "leave", leave(resumed.handle))),
      "left",
    );
  });

  it("enforces private-channel ACL on every request while allowing self-leave after owner access denial", async () => {
    const { h, operator, server, channel, fake } = await setup();
    const { member } = await h.registerMember(operator, server.owner.id);
    const room = await channel(true);
    const path = `/api/servers/${server.owner.id}/channel-member`;
    expect(
      await readHttpFailure(await media(member, "join", join(room))),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(fake.calls).toHaveLength(0);
    const allowed = await decodeApplicationResponse(
      await operator.request(path, {
        channelId: room.channelId,
        userId: member.profile!.userId,
        allowed: true,
        expectedVersion: 1,
      }),
      AdministrationOutcomeSchema,
    );
    if (allowed.kind !== "changed")
      throw new Error("Fixture private ACL grant failed.");
    const joined = kind(
      await outcome(await media(member, "join", join(room))),
      "joined",
    );
    const allocationCount = fake.calls.length;
    expect(
      await readHttpFailure(
        await media(operator, "publish", publish(joined.handle)),
      ),
    ).toMatchObject({
      code: "STALE_GENERATION",
      data: { kind: "stale_generation", currentGeneration: 0 },
    });
    expect(fake.calls).toHaveLength(allocationCount);
    const denied = await decodeApplicationResponse(
      await operator.request(path, {
        channelId: room.channelId,
        userId: member.profile!.userId,
        allowed: false,
        expectedVersion: allowed.version,
      }),
      AdministrationOutcomeSchema,
    );
    expect(denied.kind).toBe("changed");
    expect(
      await readHttpFailure(
        await media(member, "publish", publish(joined.handle)),
      ),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      await readHttpFailure(await media(member, "snapshot", { room })),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(
      fake.calls.filter((call) => call.path.endsWith("/tracks/new")),
    ).toHaveLength(0);
    const left = kind(
      await outcome(await media(member, "leave", leave(joined.handle))),
      "left",
    );
    expect(left.cleanupPending).toBe(false);
    expect(await outcome(await media(member, "status"))).toMatchObject({
      kind: "media_status",
      admission: { kind: "available" },
    });
    const snapshot = kind(
      await outcome(await media(operator, "snapshot", { room })),
      "media_snapshot",
    );
    expect(snapshot.snapshot.participants).toHaveLength(0);
  });
});

it("correlates tagged media failures with the HTTP reference without logging successful heartbeats or private input", async () => {
  const { operator, channel, fake } = await setup();
  const room = await channel();
  const joined = kind(
    await outcome(await media(operator, "join", join(room))),
    "joined",
  );
  const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await outcome(
      await media(operator, "heartbeat", { handle: joined.handle }),
    );
    expect(logger).not.toHaveBeenCalled();
    const stale = publish(joined.handle, joined.producerVersion + 7);
    const response = await media(operator, "publish", stale);
    expect(await readHttpFailure(response)).toMatchObject({
      code: "STALE_VERSION",
    });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "media_request_failed",
        requestId: response.headers.get("X-Request-ID"),
        route: "/api/media/publish",
        status: 409,
        outcome: "stale_version",
        participantId: joined.handle.participantId,
        generation: joined.handle.accountGeneration,
        operationId: stale.operationId,
        version: stale.expectedSessionVersion,
      }),
    );
    fake.unusedSessionTtlMs = 0;
    const command = publish(joined.handle);
    const failed = await media(operator, "publish", command);
    expect(await readHttpFailure(failed)).toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "media_request_failed",
        requestId: failed.headers.get("X-Request-ID"),
        outcome: "provider_error",
        operationId: command.operationId,
      }),
    );
    const retry = publish(joined.handle);
    const closed = await media(operator, "publish", retry);
    expect(await readHttpFailure(closed)).toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(logger).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "media_request_failed",
        requestId: closed.headers.get("X-Request-ID"),
        outcome: "recovery_required",
        operationId: retry.operationId,
        status: 409,
      }),
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain(
      joined.handle.deviceToken,
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain(
      command.sessionDescription.sdp,
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain("fixture-session-");
    logger.mockImplementation(() => {
      throw new Error("private-sink");
    });
    await outcome(await media(operator, "leave", leave(joined.handle)));
  } finally {
    logger.mockRestore();
  }
});
