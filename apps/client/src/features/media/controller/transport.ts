import { api } from "@/client/api/contract";
import {
  apiFailure,
  isNetworkError,
  isCancellation,
} from "@/client/api/errors";
import { ORPCError } from "@orpc/client";
import { MediaFailureSchema } from "@vaskel/contracts/media";
import {
  MediaError,
  ReplacedGeneration,
} from "@/client/features/media/protocol";

const calls = {
  status: api.mediaStatus,
  join: api.joinMedia,
  transfer: api.transferMedia,
  resume: api.resumeMedia,
  leave: api.leaveMedia,
  snapshot: api.mediaSnapshot,
  heartbeat: api.heartbeatMedia,
  publish: api.publishMedia,
  ack: api.ackMedia,
  subscribe: api.subscribeMedia,
  answer: api.answerMedia,
  unpublish: api.unpublishMedia,
  moderate: api.moderateMedia,
};
export type MediaMethod = keyof typeof calls;
export type MediaBody<K extends MediaMethod> =
  NonNullable<Parameters<(typeof calls)[K]>[0]> extends { body: infer B }
    ? B
    : undefined;
export type MediaResponse = Awaited<ReturnType<(typeof calls)[MediaMethod]>>;
export type MediaTransport = <K extends MediaMethod>(
  method: K,
  body: MediaBody<K>,
  signal: AbortSignal,
) => Promise<MediaResponse>;

/** Exact retries retain the command; native failures enter the existing call recovery. */
export function createMediaTransport(
  userId: string,
  canUseNetwork: () => boolean,
): MediaTransport {
  return async (method, body, signal) => {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      if (!canUseNetwork() && method !== "leave")
        throw new ReplacedGeneration();
      try {
        // Method and body are correlated by MediaTransport; index access loses that relation.
        const invoke = calls[method] as (
          input: { body: typeof body } | undefined,
          options: { signal: AbortSignal; context: { accountId: string } },
        ) => Promise<MediaResponse>;
        return await invoke(body === undefined ? undefined : { body }, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
          context: { accountId: userId },
        });
      } catch (error) {
        if (signal.aborted) throw new ReplacedGeneration();
        if (error instanceof ORPCError) {
          const failure = MediaFailureSchema.safeParse(
            error.data ?? { kind: error.code.toLowerCase() },
          );
          if (failure.success) throw new MediaError(failure.data);
        }
        // Contract refusals and malformed responses are explicit; only ambiguous transport retries.
        if (
          !isNetworkError(error) &&
          !isCancellation(error) &&
          apiFailure(error)
        )
          throw error;
        last = error;
      }
    }
    throw last;
  };
}
