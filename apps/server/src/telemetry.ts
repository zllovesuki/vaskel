import type { MediaOutcome } from "@vaskel/contracts/media";
import type { MediaClosureCause } from "./media/disposition";
import { RealtimeError } from "./providers/realtime/errors";
import type { ThumbnailFailureReason } from "./files/thumbnail/errors";

type Event =
  | "request_failed"
  | "attachment_thumbnail"
  | "actor_migration_failed"
  | "search_index_rebuild_failed"
  | "activity_owner_lookup_failed"
  | "block_owner_lookup_failed"
  | "cross_search_owner_unavailable"
  | "identity_mail_retry_failed"
  | "identity_mail_delivery_failed"
  | "identity_mail_retry"
  | "instance_policy_hints_failed"
  | "message_side_effect_failed"
  | "event_hint_delivery_failed"
  | "notification_offer_failed"
  | "notification_dispatch"
  | "notification_dispatch_failed"
  | "notification_transport"
  | "notification_transport_failed"
  | "notification_endpoint_feedback_failed"
  | "presence_transition_discovery_failed"
  | "owner_alarm_failed"
  | "owner_optimization_failed"
  | "provider_request_failed"
  | "provider_track_failed"
  | "media_operation_failed"
  | "media_participant_closed"
  | "media_request_failed"
  | "media_cleanup"
  | "media_alarm_failed"
  | "account_media_cleanup";

type Operation =
  | "candidates"
  | "materialize"
  | "occupancy_hint"
  | "read_broadcast"
  | "read_hint"
  | "directory_hint"
  | "commit_broadcast"
  | "commit_hint"
  | "dm_policy_broadcast"
  | "dm_policy_hint"
  | "sockets"
  | "media_invalidation"
  | "attachments"
  | "directory_sync"
  | "create_session"
  | "add_tracks"
  | "renegotiate"
  | "close_tracks"
  | "get_session"
  | "cleanup"
  | "occupancy"
  | "publish"
  | "subscribe"
  | "ack"
  | "answer"
  | "unpublish";

export interface MediaDiagnosticContext {
  readonly actorId?: string | undefined;
  readonly participantId?: string | undefined;
  readonly generation?: number | undefined;
  readonly operationId?: string | undefined;
  readonly direction?: "producer" | "consumer" | undefined;
  readonly version?: number | undefined;
  /** The absence this caller already treats as success; session scope also accepts absent tracks. */
  readonly cleanup?: "tracks" | "session" | undefined;
}

export interface ActorMigrationDiagnosticContext {
  schema:
    | "message_owner"
    | "media_room"
    | "account_media"
    | "event_dispatch"
    | "notification";
  phase:
    | "validate_plan"
    | "transaction"
    | "create_ledger"
    | "read_ledger"
    | "validate_ledger"
    | "execute_sql"
    | "write_ledger";
  reason?: "invalid_plan" | "schema_ahead" | "ledger_gap" | "name_mismatch";
  supportedVersion: number;
  observedVersion?: number;
  expectedVersion?: number;
  migrationVersion?: number;
  /** Only names from the code's migration plan, never names read from storage. */
  migrationName?: string;
}

interface Fields
  extends MediaDiagnosticContext, Partial<ActorMigrationDiagnosticContext> {
  failureReason?:
    | "eligibility_unavailable"
    | "preparation_failed"
    | "enqueue_unavailable"
    | ThumbnailFailureReason;
  requestId?: string;
  /** Matched route template, never a request URL or raw path. */
  route?: string;
  operation?: Operation;
  ownerId?: string;
  durationMs?: number;
  sourceBytes?: number;
  readBytes?: number;
  readCalls?: number;
  outputBytes?: number;
  wasmMemoryBytes?: number;
  processed?: number;
  pending?: number;
  failed?: number;
  sent?: number;
  suppressed?: number;
  queueAgeMs?: number;
  attempts?: number;
  succeeded?: number;
  status?: number;
  providerStatus?: number | undefined;
  errorSource?: "top_level" | "track" | "transport" | "response";
  providerErrors?: ReadonlyArray<{ code: string; count: number }>;
  outcome?: MediaOutcome["kind"];
  closureReason?: MediaClosureCause;
  terminalUpgrade?: boolean;
}

const providerCodes = new Set([
  "unavailable",
  "timeout",
  "network_error",
  "invalid_response",
  "unexpected_status",
  "provider_error",
  "unauthorized",
  "not_found",
  "decoding_error",
  "invalid_params",
  "payload_too_large",
  "invalid_session_description",
  "retryable_transient_error",
  "temporarily_unavailable_error",
  "transport_unavailable_error",
  "backend_error",
  "session_error",
  "close_track_error",
  "empty_track_error",
  "not_found_track_error",
  "partial_subscription",
]);

function safeProviderCode(code: string): string {
  return providerCodes.has(code) ? code : "provider_error";
}

function providerErrorCounts(errors: Fields["providerErrors"]) {
  if (!errors) return undefined;
  const counts = new Map<string, number>();
  // Responses are bounded by the provider byte cap; output has one entry per
  // allowlisted code, regardless of the number of tracks or unknown strings.
  for (const { code, count } of errors) {
    if (!Number.isSafeInteger(count) || count <= 0) continue;
    const safeCode = safeProviderCode(code);
    counts.set(
      safeCode,
      Math.min((counts.get(safeCode) ?? 0) + count, 1_048_576),
    );
  }
  return Array.from(counts, ([code, count]) => ({ code, count }));
}

function errorFields(error: unknown) {
  if (error === undefined) return {};
  if (error instanceof RealtimeError)
    return {
      errorName: "RealtimeError",
      code: safeProviderCode(error.code),
      retryable: error.retryable,
      uncertain: error.uncertain,
    };
  // Names, messages, stacks and causes can all contain private upstream text.
  const errorName =
    error instanceof TypeError
      ? "TypeError"
      : error instanceof RangeError
        ? "RangeError"
        : error instanceof SyntaxError
          ? "SyntaxError"
          : error instanceof Error
            ? "Error"
            : "UnknownError";
  return { errorName };
}

/** Best effort diagnostics. Never pass payloads or spread caller objects into logs. */
export function logEvent(
  level: "error" | "warn" | "log",
  event: Event,
  fields: Fields = {},
  error?: unknown,
): void {
  try {
    const entry = {
      event,
      requestId: fields.requestId,
      failureReason: fields.failureReason,
      route: fields.route,
      operation: fields.operation,
      actorId: fields.actorId,
      schema: fields.schema,
      phase: fields.phase,
      reason: fields.reason,
      supportedVersion: fields.supportedVersion,
      observedVersion: fields.observedVersion,
      expectedVersion: fields.expectedVersion,
      migrationVersion: fields.migrationVersion,
      migrationName: fields.migrationName,
      ownerId: fields.ownerId,
      participantId: fields.participantId,
      generation: fields.generation,
      operationId: fields.operationId,
      direction: fields.direction,
      version: fields.version,
      cleanup: fields.cleanup,
      status: fields.status,
      providerStatus: fields.providerStatus,
      errorSource: fields.errorSource,
      providerErrors: providerErrorCounts(fields.providerErrors),
      outcome: fields.outcome,
      closureReason: fields.closureReason,
      terminalUpgrade: fields.terminalUpgrade,
      succeeded: fields.succeeded,
      durationMs: fields.durationMs,
      sourceBytes: fields.sourceBytes,
      readBytes: fields.readBytes,
      readCalls: fields.readCalls,
      outputBytes: fields.outputBytes,
      wasmMemoryBytes: fields.wasmMemoryBytes,
      processed: fields.processed,
      pending: fields.pending,
      failed: fields.failed,
      sent: fields.sent,
      suppressed: fields.suppressed,
      queueAgeMs: fields.queueAgeMs,
      attempts: fields.attempts,
      ...errorFields(error),
    };
    console[level](
      Object.fromEntries(
        Object.entries(entry).filter(([, value]) => value !== undefined),
      ),
    );
  } catch {
    // Diagnostics must not change an accepted command or interrupt cleanup.
  }
}
