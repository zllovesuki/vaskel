import {
  type AccountMediaOutcome,
  type JoinMediaRequest,
  type ResumeMediaRequest,
  type LeaveMediaRequest,
  type MediaHandle,
  type MediaRoomRef,
  type MediaFailure,
  type MediaEndReason,
  type PendingMediaCommand,
} from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import {
  mediaRoomKey,
  type MediaAuthorization,
  type AccountClaim,
} from "@/server/media/authorization";
import {
  authorizationError,
  commandTimeError,
  principalError,
} from "@/server/media/runtime";
import { sha256Hex } from "@/server/auth/crypto";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { accountDatabase } from "./store";
import {
  accountCommand,
  accountCommandHash,
  leaveCommandHash,
} from "@/server/actors/account-media/commands";
import { findAccountState, readAccountState, saveAccountState } from "./store";
import {
  accountStatus,
  cleanupOf,
  endpointOf,
  endParticipation,
  hasIntent,
  previousTokenHash,
  recoverParticipation,
  type AccountState,
  type Participation,
} from "./state";
import {
  endedParticipation,
  validateHandle,
  validatePendingLeave,
  admissionFailure,
} from "./claims";
import {
  closePreviousClaim,
  disposePreviousClaim,
  runAccountAlarm,
  refreshAccountAlarm,
} from "./cleanup";

/** Typed account RPC lifecycle; ordinary SDP operations remain room-local. */
export class AccountMediaCoordinator {
  private readonly database;
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.database = accountDatabase(ctx.storage, ctx.id.toString());
  }
  async status(principal: Principal): Promise<AccountMediaOutcome> {
    const denied = principalError(principal);
    if (denied) return denied;
    const state = await readAccountState(this.database, principal.userId);
    return accountStatus(state);
  }
  join(
    principal: Principal,
    authorization: MediaAuthorization,
    request: JoinMediaRequest,
  ) {
    return this.begin(principal, authorization, {
      path: "join",
      body: request,
    });
  }
  transfer(
    principal: Principal,
    authorization: MediaAuthorization,
    request: JoinMediaRequest,
  ) {
    return this.begin(principal, authorization, {
      path: "transfer",
      body: request,
    });
  }
  async resume(
    principal: Principal,
    authorization: MediaAuthorization,
    request: ResumeMediaRequest,
  ): Promise<AccountMediaOutcome> {
    return this.begin(principal, authorization, {
      path: "resume",
      body: request,
    });
  }
  async leave(
    principal: Principal,
    request: LeaveMediaRequest,
  ): Promise<AccountMediaOutcome> {
    const hash = await leaveCommandHash(request);
    const denied = principalError(principal);
    if (denied) return denied;
    const pending =
      "pending" in request ? accountCommand(request.pending) : null;
    const pendingHash = pending ? await accountCommandHash(pending) : null;
    const changed = await this.ctx.storage.transaction(async () => {
      const denied = principalError(principal);
      if (denied) return denied;
      const state = await readAccountState(
        this.database,
        principal.userId,
        false,
      );
      if (
        state.receipt?.commandId === request.commandId &&
        state.receipt.operation === "leave"
      ) {
        if (state.receipt.hash !== hash)
          return { kind: "command_conflict" as const };
        if (state.receipt.sessionId !== principal.sessionId)
          return { kind: "forbidden" as const };
        return state;
      }
      const valid =
        "handle" in request
          ? await validateHandle(state, principal, request.handle)
          : await validatePendingLeave(
              state,
              principal,
              pending!,
              pendingHash!,
            );
      if (valid) return valid;
      const expired = commandTimeError(request.issuedAt);
      if (expired) return expired;
      // Resume retains its predecessor enforcement barrier. Transfer has already
      // retired that obligation; Leave fences the currently accepted destination.
      const next: AccountState = {
        ...state,
        generation: state.generation + 1,
        participation: endParticipation(state, {
          kind: "leave",
          sessionId: principal.sessionId,
        }),
        receipt: {
          commandId: request.commandId,
          hash,
          operation: "leave",
          sessionId: principal.sessionId,
        },
      };
      await saveAccountState(this.database, next);
      if (cleanupOf(next.participation))
        await scheduleAlarm(this.ctx.storage, Date.now() + 1);
      return next;
    });
    if ("kind" in changed) return changed;
    const closed = await closePreviousClaim(
      this.ctx,
      this.env,
      this.database,
      changed,
    );
    return {
      kind: "left",
      generation: changed.generation,
      cleanupPending: !closed,
    };
  }
  async validateClaim(
    principal: Principal,
    handle: MediaHandle,
  ): Promise<MediaFailure | { kind: "valid_claim" }> {
    const denied = principalError(principal);
    if (denied) return denied;
    return this.ctx.storage.transaction(async () => {
      const state = await readAccountState(this.database, principal.userId);
      const failure = await validateHandle(state, principal, handle);
      if (failure) return failure;
      if (!hasIntent(state.participation)) return endedParticipation(state);
      if (state.participation.kind !== "active")
        return {
          kind: "recovery_required",
          handle,
          reason: "admission_failed",
        };
      return { kind: "valid_claim" };
    });
  }
  async validateAdmission(
    claim: AccountClaim,
  ): Promise<MediaFailure | { kind: "valid_claim" }> {
    return this.ctx.storage.transaction(async () => {
      const state = await readAccountState(this.database, claim.userId);
      if (state.generation !== claim.generation)
        return {
          kind: "stale_generation",
          currentGeneration: state.generation,
        };
      const endpoint = endpointOf(state.participation);
      if (
        !endpoint ||
        endpoint.tokenHash !== claim.tokenHash ||
        endpoint.sessionId !== claim.sessionId ||
        endpoint.clientId !== claim.clientId ||
        state.userId !== claim.participantId ||
        mediaRoomKey(endpoint.room) !== mediaRoomKey(claim.room)
      )
        return { kind: "forbidden" };
      if (!hasIntent(state.participation)) return endedParticipation(state);
      switch (state.participation.kind) {
        case "active":
          return { kind: "valid_claim" };
        case "joining":
          if (!state.participation.predecessor) return { kind: "valid_claim" };
          break;
      }
      return { kind: "cleanup_pending", generation: state.generation };
    });
  }
  async recordUnadmittedRevocation(
    room: MediaRoomRef,
    permissionGeneration: number,
  ): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const state = await findAccountState(this.database);
      if (
        !state ||
        !hasIntent(state.participation) ||
        state.participation.endpoint.permissionGeneration >=
          permissionGeneration ||
        mediaRoomKey(state.participation.endpoint.room) !== mediaRoomKey(room)
      )
        return;
      await saveAccountState(this.database, {
        ...state,
        participation: endParticipation(state, {
          kind: "terminal",
          reason: "permission_revoked",
        }),
      });
      await scheduleAlarm(this.ctx.storage, Date.now() + 1);
    });
  }
  async recordRemoval(
    room: MediaRoomRef,
    generation: number,
    reason: MediaEndReason = "removed",
  ): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const state = await findAccountState(this.database);
      if (!state || !hasIntent(state.participation)) return;
      const currentIntent =
        state.generation === generation &&
        mediaRoomKey(state.participation.endpoint.room) === mediaRoomKey(room);
      const cleanup = cleanupOf(state.participation);
      const inheritedIntent =
        cleanup?.generation === generation &&
        mediaRoomKey(cleanup.room) === mediaRoomKey(room);
      if (!currentIntent && !inheritedIntent) return;
      await saveAccountState(this.database, {
        ...state,
        participation: endParticipation(state, { kind: "terminal", reason }),
      });
      await scheduleAlarm(this.ctx.storage, Date.now() + 1);
    });
  }
  async isObsolete(room: MediaRoomRef, generation: number) {
    const state = await findAccountState(this.database);
    if (!state || state.generation <= generation) return false;
    // An unfinished Resume or deliberate Leave retains its enforcement obligation.
    const cleanup = cleanupOf(state.participation);
    return !(
      cleanup?.generation === generation &&
      mediaRoomKey(cleanup.room) === mediaRoomKey(room)
    );
  }
  alarm() {
    return runAccountAlarm(this.ctx, this.env, this.database);
  }
  private async begin(
    principal: Principal,
    authorization: MediaAuthorization,
    pending: PendingMediaCommand,
  ): Promise<AccountMediaOutcome> {
    const command = accountCommand(pending);
    const { request, operation, resumeHandle } = command;
    const denied = authorizationError(principal, authorization, request.room);
    if (denied) return denied;
    if (
      !this.env.REALTIME_APP_ID?.trim() ||
      !this.env.REALTIME_APP_SECRET?.trim()
    )
      return { kind: "unavailable" };
    const payloadHash = await accountCommandHash(command);
    const tokenHash = await sha256Hex(request.deviceToken);
    const changed = await this.ctx.storage.transaction(async () => {
      const denied = authorizationError(principal, authorization, request.room);
      if (denied) return denied;
      const state = await readAccountState(
        this.database,
        principal.userId,
        false,
      );
      if (
        state.receipt?.commandId === request.commandId &&
        state.receipt.operation === operation
      ) {
        if (state.receipt.hash !== payloadHash)
          return { kind: "command_conflict" as const };
        if (state.receipt.sessionId !== principal.sessionId)
          return { kind: "forbidden" as const };
        return state;
      }
      const expired = commandTimeError(request.issuedAt);
      if (expired) return expired;
      if (state.generation !== request.expectedGeneration)
        return {
          kind: "stale_generation" as const,
          currentGeneration: state.generation,
        };
      if (operation === "resume") {
        if (!resumeHandle) return { kind: "invalid_input" as const };
        const valid = await validateHandle(state, principal, resumeHandle);
        if (valid) return valid;
        if (!hasIntent(state.participation)) return endedParticipation(state);
      }
      if (previousTokenHash(state.participation) === tokenHash)
        return { kind: "invalid_input" as const };
      const refused = admissionFailure(state, operation);
      if (refused) return refused;
      // Bound accepted replacement churn independently of room participation.
      // The bounded window is committed with the command; receipt retries bypass it.
      if (operation === "transfer") {
        const recent = (
          (await this.ctx.storage.get<number[]>("transfer-window")) ?? []
        ).filter((at) => at > Date.now() - 60_000);
        // The KV read may suspend; expired authority cannot replace the active
        // generation or consume its transfer allowance after that boundary.
        const denied = authorizationError(
          principal,
          authorization,
          request.room,
        );
        if (denied) return denied;
        if (recent.length >= 16) return { kind: "capacity" as const };
        await this.ctx.storage.put("transfer-window", [...recent, Date.now()]);
      }
      const predecessor =
        operation === "resume" ? endpointOf(state.participation) : null;
      const participation: Extract<Participation, { kind: "joining" }> = {
        kind: "joining",
        endpoint: {
          room: request.room,
          clientId: request.clientId,
          sessionId: principal.sessionId,
          tokenHash,
          permissionGeneration: authorization.permissionGeneration,
        },
        deadline: Date.now() + 30_000,
        predecessor: predecessor
          ? {
              room: predecessor.room,
              generation: state.generation,
              reason: "replace",
            }
          : null,
      };
      const next: AccountState = {
        userId: principal.userId,
        generation: state.generation + 1,
        participation,
        receipt: {
          commandId: request.commandId,
          hash: payloadHash,
          operation,
          sessionId: principal.sessionId,
        },
      };
      await saveAccountState(this.database, next);
      await scheduleAlarm(
        this.ctx.storage,
        participation.predecessor ? Date.now() + 1 : participation.deadline,
      );
      return {
        ...next,
        obsolete: operation === "transfer" ? state : null,
      };
    });
    if ("kind" in changed) return changed;
    if ("obsolete" in changed && changed.obsolete)
      disposePreviousClaim(this.ctx, this.env, changed.obsolete);
    const closed =
      !cleanupOf(changed.participation) ||
      (await closePreviousClaim(this.ctx, this.env, this.database, changed));
    const current = await readAccountState(this.database, principal.userId);
    if (current.generation !== changed.generation)
      return {
        kind: "stale_generation",
        currentGeneration: current.generation,
      };
    if (!hasIntent(current.participation)) return endedParticipation(current);
    const handle: MediaHandle = {
      room: request.room,
      participantId: principal.userId,
      accountGeneration: current.generation,
      clientId: request.clientId,
      deviceToken: request.deviceToken,
    };
    if (!closed && current.participation.kind === "joining")
      return { kind: "cleanup_pending", generation: current.generation };
    if (
      current.participation.kind !== "joining" &&
      current.participation.kind !== "active"
    )
      return { kind: "recovery_required", handle, reason: "admission_failed" };
    const claim: AccountClaim = {
      room: request.room,
      userId: principal.userId,
      sessionId: principal.sessionId,
      clientId: request.clientId,
      tokenHash,
      generation: current.generation,
      participantId: principal.userId,
    };
    const admitted = await this.env.MEDIA_ROOM.getByName(
      mediaRoomKey(request.room),
    ).admit(claim, authorization);
    if (admitted.kind !== "admitted") {
      await this.ctx.storage.transaction(async () => {
        const latest = await readAccountState(this.database, principal.userId);
        if (
          latest.generation !== claim.generation ||
          !hasIntent(latest.participation)
        )
          return;
        await saveAccountState(this.database, {
          ...latest,
          participation:
            admitted.kind === "participation_ended"
              ? endParticipation(latest, {
                  kind: "terminal",
                  reason: admitted.reason,
                })
              : recoverParticipation(latest),
        });
        await scheduleAlarm(this.ctx.storage, Date.now() + 1);
      });
      const latest = await readAccountState(this.database, principal.userId);
      if (
        latest.generation === claim.generation &&
        !hasIntent(latest.participation)
      )
        return endedParticipation(latest);
      return admitted.kind === "admission_recovery"
        ? { kind: "recovery_required", handle, reason: admitted.reason }
        : admitted;
    }
    const accepted = await this.ctx.storage.transaction(async () => {
      const latest = await readAccountState(this.database, principal.userId);
      if (
        latest.generation !== claim.generation ||
        (latest.participation.kind !== "joining" &&
          latest.participation.kind !== "active")
      )
        return false;
      await saveAccountState(this.database, {
        ...latest,
        participation: {
          kind: "active",
          endpoint: latest.participation.endpoint,
        },
      });
      return true;
    });
    await refreshAccountAlarm(this.ctx, this.database);
    if (!accepted) {
      disposePreviousClaim(this.ctx, this.env, current);
      const latest = await readAccountState(this.database, principal.userId);
      if (
        latest.generation === claim.generation &&
        !hasIntent(latest.participation)
      )
        return endedParticipation(latest);
      return {
        kind: "stale_generation",
        currentGeneration: latest.generation,
      };
    }
    return {
      kind: "joined",
      handle,
      generation: claim.generation,
      producerVersion: admitted.producerVersion,
      consumerVersion: admitted.consumerVersion,
      snapshot: admitted.snapshot,
    };
  }
}
