import { recordClosure, sessionContext } from "./diagnostics";
import {
  actorWork,
  ACTOR_RPC_TIMEOUT_MS,
} from "@/server/actors/shared/bounded-work";
import { closureDisposition } from "@/server/media/disposition";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  revision,
  sessionKey,
  type ParticipantRow,
  type RoomRuntime,
} from "./store";

/** Caller owns the transaction. Terminal enforcement can never become disposable. */
export async function retireTransferredParticipant(
  rt: RoomRuntime,
  participant: ParticipantRow,
) {
  if (
    participant.status === "left" ||
    closureDisposition(participant.reason).kind === "terminal"
  )
    return false;
  await rt.db
    .updateTable("media_participants")
    .set({
      status: "left",
      reason: "transfer",
      closed_at: Date.now(),
      cleanup_at: null,
    })
    .where("id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  await rt.db
    .updateTable("media_subscriptions")
    .set({ source_transferred: 1 })
    .where(
      "source_session_key",
      "=",
      sessionKey(participant.id, participant.generation, "producer"),
    )
    .execute();
  await rt.db
    .updateTable("media_publications")
    .set({ ready: 0 })
    .where("participant_id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  recordClosure(rt, participant, "transfer");
  await revision(rt);
  await scheduleAlarm(rt.ctx.storage, Date.now() + 1_000);
  return true;
}

/** Best effort only: copied locators are not a durable per-track completion ledger. */
export async function disposeTransferredParticipant(
  rt: RoomRuntime,
  participant: ParticipantRow,
) {
  const sessions = await rt.db
    .selectFrom("media_sessions")
    .selectAll()
    .where("participant_id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  for (const session of sessions) {
    const pending = [
      rt.inflight.get(`cleanup:${participant.id}:${participant.generation}`),
      rt.inflight.get(session.session_key),
      rt.inflight.get(`scope:${session.session_key}`),
    ];
    void actorWork(rt.ctx.storage, "hints").run(
      async () => {
        // An old exchange keeps its own serialization even though admission moved on.
        await Promise.allSettled(pending);
        const current = await rt.db
          .selectFrom("media_sessions")
          .select("provider_id")
          .where("session_key", "=", session.session_key)
          .executeTakeFirst();
        const providerId = current?.provider_id ?? session.provider_id;
        if (!providerId) return;
        const remote = await rt.provider.getSession(providerId, {
          ...sessionContext(rt, session),
          cleanup: "session",
        });
        const mids = remote.tracks.flatMap((track) =>
          track.mid ? [track.mid] : [],
        );
        if (mids.length)
          await rt.provider.closeTracks(providerId, mids, {
            ...sessionContext(rt, session),
            cleanup: "session",
          });
      },
      Date.now() + ACTOR_RPC_TIMEOUT_MS,
      `dispose:${session.session_key}`,
    );
  }
}
