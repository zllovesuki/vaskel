import { logEvent, type MediaDiagnosticContext } from "@/server/telemetry";
import {
  closureDisposition,
  type MediaClosureCause,
} from "@/server/media/disposition";
import type { ParticipantRow, RoomRuntime, SessionRow } from "./store";

export type ClosureEvent = MediaDiagnosticContext & {
  closureReason: MediaClosureCause;
  terminalUpgrade: boolean;
};

export function sessionContext(
  rt: RoomRuntime,
  session: SessionRow,
): MediaDiagnosticContext {
  return {
    actorId: rt.ctx.id.toString(),
    participantId: session.participant_id,
    generation: session.generation,
    direction: session.direction,
    ...(session.operation_id ? { operationId: session.operation_id } : {}),
    version: session.version,
  };
}

/** Each invocation owns its events; rollback discards them with the native commit. */
export async function mediaTransaction<T>(
  rt: RoomRuntime,
  run: (transaction: RoomRuntime) => Promise<T>,
): Promise<T> {
  const { result, events } = await rt.ctx.storage.transaction(async () => {
    const events: ClosureEvent[] = [];
    const result = await run({ ...rt, closureEvents: events });
    return { result, events };
  });
  if (rt.closureEvents) rt.closureEvents.push(...events);
  else
    for (const event of events)
      logEvent("log", "media_participant_closed", event);
  return result;
}

export function recordClosure(
  rt: RoomRuntime,
  previous: ParticipantRow,
  cause: MediaClosureCause,
) {
  if (previous.reason === cause) return;
  rt.closureEvents?.push({
    actorId: rt.ctx.id.toString(),
    participantId: previous.id,
    generation: previous.generation,
    closureReason: cause,
    terminalUpgrade:
      previous.reason !== null &&
      closureDisposition(previous.reason).kind !== "terminal" &&
      closureDisposition(cause).kind === "terminal",
  });
}
