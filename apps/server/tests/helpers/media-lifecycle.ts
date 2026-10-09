import { moderationTarget } from "@tests/helpers/media-room";
import { barrier } from "@tests/helpers/barrier";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { MediaHandle, MediaSource } from "@vaskel/contracts/media";
import { mediaRoomKey } from "@/server/media/authorization";
import type { MediaSfu } from "@tests/fixtures/media-sfu";
import {
  grant,
  joined,
  publishReady,
  request,
  type setup,
  user,
} from "@tests/helpers/media-room";

export type LifecycleFixture = ReturnType<typeof setup>;

export async function participant(fixture: LifecycleFixture, userId: string) {
  const principal = { ...user(), userId };
  const account = env.ACCOUNT_MEDIA.getByName(principal.userId);
  const accepted = joined(
    await account.join(
      principal,
      grant(principal, fixture.scope),
      request(fixture.scope),
    ),
  );
  return { principal, account, accepted };
}

export type LifecycleParticipant = Awaited<ReturnType<typeof participant>>;

export async function interruptActors(
  fixture: LifecycleFixture,
  person: LifecycleParticipant,
) {
  await abortAllDurableObjects();
  // Forced interruption breaks existing stubs; reconnect to the same actors.
  fixture.media = env.MEDIA_ROOM.getByName(mediaRoomKey(fixture.scope));
  fixture.account = env.ACCOUNT_MEDIA.getByName(fixture.principal.userId);
  person.account = env.ACCOUNT_MEDIA.getByName(person.principal.userId);
}

export function publishParticipant(
  fixture: LifecycleFixture,
  person: LifecycleParticipant,
  sources: MediaSource[] = ["microphone"],
) {
  return publishReady(
    { ...fixture, principal: person.principal, account: person.account },
    person.accepted.handle,
    sources,
  );
}

export function providerSession(
  fixture: LifecycleFixture,
  handle: MediaHandle,
  direction: "producer" | "consumer" = "producer",
) {
  return runInDurableObject(
    fixture.media,
    (_instance, state) =>
      state.storage.sql
        .exec<{ provider_id: string }>(
          "SELECT provider_id FROM media_sessions WHERE participant_id=? AND generation=? AND direction=?",
          handle.participantId,
          handle.accountGeneration,
          direction,
        )
        .one().provider_id,
  );
}

/** Gate only the external fixture; actor RPC, SQL and alarms remain real. */
export function blockProviderSession(
  fake: MediaSfu,
  sessionId: string,
  endpoint: "inspect" | "close" = "inspect",
) {
  const gate = barrier();
  const fetcher = fake.fetcher;
  let entered = false;
  fake.fetcher = async (input, init) => {
    const request = new Request(input, init);
    if (
      request.method === (endpoint === "inspect" ? "GET" : "PUT") &&
      new URL(request.url).pathname ===
        `/v1/apps/fixture-app/sessions/${encodeURIComponent(sessionId)}${endpoint === "close" ? "/tracks/close" : ""}`
    ) {
      entered = true;
      await gate.promise;
    }
    return fetcher(request);
  };
  return {
    wait: () => expect.poll(() => entered).toBe(true),
    release: gate.release,
  };
}

export async function removalRequest(
  fixture: LifecycleFixture,
  person: LifecycleParticipant,
) {
  const snapshot = await fixture.media.snapshot(
    fixture.principal,
    grant(fixture.principal, fixture.scope),
    { room: fixture.scope },
  );
  if (snapshot.kind !== "media_snapshot")
    throw new Error("Expected room snapshot.");
  return {
    room: fixture.scope,
    userId: person.principal.userId,
    action: "remove" as const,
    enabled: true,
    commandId: crypto.randomUUID(),
    ...moderationTarget(
      snapshot.snapshot.participants.some(
        (p) => p.userId === person.principal.userId,
      )
        ? snapshot.snapshot
        : person.accepted.snapshot,
      person.principal.userId,
    ),
  };
}

export async function interruptRemovalNotification(
  fixture: LifecycleFixture,
  person: LifecycleParticipant,
) {
  // Reject notification's terminal cleanup write while permitting the barrier
  // to cancel intent after its retained cleanup target has closed.
  await runInDurableObject(person.account, (_instance, state) => {
    state.storage.sql.exec(
      `CREATE TRIGGER fixture_interrupted_removal
       BEFORE UPDATE OF participation ON account_media
       WHEN json_extract(OLD.participation, '$.kind') IN ('joining','active','recovering','resumable')
        AND json_extract(NEW.participation, '$.kind') = 'ending'
       BEGIN SELECT RAISE(ABORT, 'fixture removal interruption'); END`,
    );
  });
  try {
    const result = await fixture.media.moderate(
      fixture.principal,
      grant(fixture.principal, fixture.scope),
      await removalRequest(fixture, person),
    );
    expect(result).toMatchObject({ kind: "moderated" });
  } catch (error) {
    expect(String(error)).toContain("fixture removal interruption");
  }
  expect(await person.account.status(person.principal)).toMatchObject({
    kind: "media_status",
    generation: person.accepted.generation,
    admission: { kind: "transfer_required" },
  });
  await runInDurableObject(fixture.media, (_instance, state) => {
    expect(
      state.storage.sql
        .exec<{ reason: string }>(
          "SELECT reason FROM media_participants WHERE id=? AND generation=?",
          person.accepted.handle.participantId,
          person.accepted.generation,
        )
        .one().reason,
    ).toBe("removed");
  });
}

export function restoreRemovalNotification(person: LifecycleParticipant) {
  return runInDurableObject(person.account, (_instance, state) => {
    state.storage.sql.exec("DROP TRIGGER fixture_interrupted_removal");
  });
}

export async function snapshot(fixture: LifecycleFixture) {
  const result = await fixture.media.snapshot(
    fixture.principal,
    grant(fixture.principal, fixture.scope),
    { room: fixture.scope },
  );
  if (result.kind !== "media_snapshot")
    throw new Error("Expected room snapshot.");
  return result.snapshot;
}

export function forwardingCount(fake: MediaSfu) {
  return [...fake.sessions.values()].reduce(
    (total, session) => total + session.tracks.size,
    0,
  );
}
