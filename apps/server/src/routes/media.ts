import type { MediaHandle } from "@vaskel/contracts/media";
import type { IdentityPrincipal } from "@/server/auth/principal";
import { type MediaFailure, type MediaRoomRef } from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import { type MediaAuthorization } from "@/server/media/authorization";
import { os } from "@orpc/server";
import { z } from "zod";
import type { MediaOutcome } from "@vaskel/contracts/media";

import { privateProcedures, type Ingress } from "@/server/http/procedures";
import { failOutcome, expectedOutcome, outcomeError } from "@/server/http/orpc";
import { directoryDatabase } from "@/server/directory/database";
import { actorPrincipal, ownerStub } from "@/server/directory/owners";
import { allowApplicationRequest } from "@/server/http/access";
import { mediaRoomKey } from "@/server/media/authorization";
import { logEvent } from "@/server/telemetry";
async function authorization(
  env: Env,
  principal: Principal,
  room: MediaRoomRef,
): Promise<{ kind: "authorized"; grant: MediaAuthorization } | MediaFailure> {
  if (!z.uuid().safeParse(room.owner.id).success)
    return { kind: "invalid_input" };
  const row = await directoryDatabase(env)
    .selectFrom("resource_directory")
    .select("id")
    .where("id", "=", room.owner.id)
    .where("kind", "=", room.owner.kind)
    .where("lifecycle", "=", "ready")
    .executeTakeFirst();
  if (!row) return { kind: "not_found" };
  const result = await ownerStub(env, room.owner).authorizeMedia(principal, {
    channelId: room.channelId,
  });
  if (result.kind !== "media_authorized") return result;
  return {
    kind: "authorized",
    grant: result.authorization,
  };
}

type MediaContext = Ingress & { principal: IdentityPrincipal };
const budget = os
  .$context<MediaContext>()
  .middleware(async ({ context, next }) => {
    if (
      !(await allowApplicationRequest(
        context.env,
        `media:${context.principal.userId}`,
      ))
    )
      failOutcome({ kind: "capacity" });
    return next();
  });
const authorized = os
  .$context<MediaContext>()
  .middleware(async ({ context, next }, room: MediaRoomRef) => {
    const result = await authorization(
      context.env,
      actorPrincipal(context.principal),
      room,
    );
    if (result.kind !== "authorized") failOutcome(result);
    return next({ context: { grant: result.grant } });
  });
interface MediaCommandFacts {
  room?: MediaRoomRef;
  handle?: MediaHandle;
  operationId?: string;
  expectedSessionVersion?: number;
  commandId?: string;
}
function result<K extends MediaOutcome["kind"]>(
  context: MediaContext,
  outcome: MediaOutcome,
  input: MediaCommandFacts | undefined,
  ...kinds: K[]
) {
  if (!kinds.includes(outcome.kind as K)) {
    const room = input?.room ?? input?.handle?.room;
    logEvent("warn", "media_request_failed", {
      requestId: context.requestId,
      route: new URL(context.request.url).pathname,
      status: outcomeError(outcome).status,
      outcome: outcome.kind,
      ...(room
        ? {
            actorId: context.env.MEDIA_ROOM.idFromName(
              mediaRoomKey(room),
            ).toString(),
          }
        : {}),
      ...(input?.handle
        ? {
            participantId: input.handle.participantId,
            generation: input.handle.accountGeneration,
          }
        : {}),
      ...(input?.operationId ? { operationId: input.operationId } : {}),
      ...(input?.expectedSessionVersion !== undefined
        ? { version: input.expectedSessionVersion }
        : {}),
    });
  }
  return expectedOutcome(outcome, ...kinds);
}

const media = privateProcedures.use(budget);
export const mediaProcedures = {
  mediaConfig: media.mediaConfig.handler(({ context }) => ({
    kind: "media_configuration" as const,
    configured: Boolean(
      context.env.REALTIME_APP_ID?.trim() &&
      context.env.REALTIME_APP_SECRET?.trim(),
    ),
    maxParticipants: 16,
  })),
  mediaStatus: media.mediaStatus.handler(async ({ context }) =>
    result(
      context,
      await context.env.ACCOUNT_MEDIA.getByName(
        context.principal.userId,
      ).status(actorPrincipal(context.principal)),
      undefined,
      "media_status",
    ),
  ),
  // Leave uses account authority, including after room access is lost.
  leaveMedia: media.leaveMedia.handler(async ({ context, input }) =>
    result(
      context,
      await context.env.ACCOUNT_MEDIA.getByName(context.principal.userId).leave(
        actorPrincipal(context.principal),
        input.body,
      ),
      input.body,
      "left",
      "cleanup_pending",
    ),
  ),
  joinMedia: media.joinMedia
    .use(authorized, (input) => input.body.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.ACCOUNT_MEDIA.getByName(
          context.principal.userId,
        ).join(actorPrincipal(context.principal), context.grant, input.body),
        input.body,
        "joined",
      ),
    ),
  transferMedia: media.transferMedia
    .use(authorized, (input) => input.body.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.ACCOUNT_MEDIA.getByName(
          context.principal.userId,
        ).transfer(
          actorPrincipal(context.principal),
          context.grant,
          input.body,
        ),
        input.body,
        "joined",
      ),
    ),
  resumeMedia: media.resumeMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.ACCOUNT_MEDIA.getByName(
          context.principal.userId,
        ).resume(actorPrincipal(context.principal), context.grant, input.body),
        input.body,
        "joined",
      ),
    ),
  mediaSnapshot: media.mediaSnapshot
    .use(authorized, (input) => input.body.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.room),
        ).snapshot(
          actorPrincipal(context.principal),
          context.grant,
          input.body,
        ),
        input.body,
        "media_snapshot",
      ),
    ),
  heartbeatMedia: media.heartbeatMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.handle.room),
        ).heartbeat(
          actorPrincipal(context.principal),
          context.grant,
          input.body,
        ),
        input.body,
        "heartbeat",
      ),
    ),
  publishMedia: media.publishMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.handle.room),
        ).publish(actorPrincipal(context.principal), context.grant, input.body),
        input.body,
        "negotiation",
        "completed",
      ),
    ),
  ackMedia: media.ackMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.handle.room),
        ).ack(actorPrincipal(context.principal), context.grant, input.body),
        input.body,
        "completed",
      ),
    ),
  subscribeMedia: media.subscribeMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.handle.room),
        ).subscribe(
          actorPrincipal(context.principal),
          context.grant,
          input.body,
        ),
        input.body,
        "negotiation",
        "completed",
      ),
    ),
  answerMedia: media.answerMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.handle.room),
        ).answer(actorPrincipal(context.principal), context.grant, input.body),
        input.body,
        "negotiation",
        "completed",
      ),
    ),
  unpublishMedia: media.unpublishMedia
    .use(authorized, (input) => input.body.handle.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.handle.room),
        ).unpublish(
          actorPrincipal(context.principal),
          context.grant,
          input.body,
        ),
        input.body,
        "negotiation",
        "completed",
      ),
    ),
  moderateMedia: media.moderateMedia
    .use(authorized, (input) => input.body.room)
    .handler(async ({ context, input }) =>
      result(
        context,
        await context.env.MEDIA_ROOM.getByName(
          mediaRoomKey(input.body.room),
        ).moderate(
          actorPrincipal(context.principal),
          context.grant,
          input.body,
        ),
        input.body,
        "moderated",
      ),
    ),
};
