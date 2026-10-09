import { DurableObject } from "cloudflare:workers";
import type { Principal } from "@/server/domain/principal";
import type {
  AccountClaim,
  MediaAuthorization,
} from "@/server/media/authorization";
import type {
  JoinMediaRequest,
  ResumeMediaRequest,
  LeaveMediaRequest,
  MediaHandle,
  MediaRoomRef,
  MediaEndReason,
} from "@vaskel/contracts/media";
import { AccountMediaCoordinator } from "@/server/actors/account-media/lifecycle";
/** Thin account-scoped lifecycle entry point; all native transactions remain local. */
export class AccountMediaDO extends DurableObject<Env> {
  private readonly coordinator;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.coordinator = new AccountMediaCoordinator(ctx, env);
  }
  status(principal: Principal) {
    return this.coordinator.status(principal);
  }
  join(
    principal: Principal,
    authorization: MediaAuthorization,
    request: JoinMediaRequest,
  ) {
    return this.coordinator.join(principal, authorization, request);
  }
  transfer(
    principal: Principal,
    authorization: MediaAuthorization,
    request: JoinMediaRequest,
  ) {
    return this.coordinator.transfer(principal, authorization, request);
  }
  resume(
    principal: Principal,
    authorization: MediaAuthorization,
    request: ResumeMediaRequest,
  ) {
    return this.coordinator.resume(principal, authorization, request);
  }
  leave(principal: Principal, request: LeaveMediaRequest) {
    return this.coordinator.leave(principal, request);
  }
  validateClaim(principal: Principal, handle: MediaHandle) {
    return this.coordinator.validateClaim(principal, handle);
  }
  validateAdmission(claim: AccountClaim) {
    return this.coordinator.validateAdmission(claim);
  }
  recordUnadmittedRevocation(room: MediaRoomRef, generation: number) {
    return this.coordinator.recordUnadmittedRevocation(room, generation);
  }
  recordRemoval(
    room: MediaRoomRef,
    generation: number,
    reason?: MediaEndReason,
  ) {
    return this.coordinator.recordRemoval(room, generation, reason);
  }
  isObsolete(room: MediaRoomRef, generation: number) {
    return this.coordinator.isObsolete(room, generation);
  }
  override alarm() {
    return this.coordinator.alarm();
  }
}
