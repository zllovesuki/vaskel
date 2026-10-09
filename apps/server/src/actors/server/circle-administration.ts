import type { Kysely } from "kysely";
import type { z } from "zod";
import type {
  AdministrationOutcome,
  ServerSettingsSchema,
  SetRoleSchema,
  TransferOwnershipSchema,
} from "@vaskel/contracts/administration";
import type { Principal } from "@/server/domain/principal";
import type { OwnerDatabase } from "@/server/actors/shared/database";
import { membership, ownerAccess } from "@/server/actors/shared/policy";

export function updateSettings(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: z.infer<typeof ServerSettingsSchema>,
): Promise<AdministrationOutcome> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: state.version };
    await database
      .updateTable("owner_state")
      .set({
        members_may_invite: Number(command.membersMayInvite),
        version: state.version + 1,
      })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: state.version + 1 };
  });
}

export function setRole(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: z.infer<typeof SetRoleSchema>,
): Promise<AdministrationOutcome> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: state.version };
    const target = await membership(database, command.userId);
    if (!target) return { kind: "not_found" };
    if (target.role === "owner") return { kind: "forbidden" };
    await database
      .updateTable("members")
      .set({ role: command.role })
      .where("user_id", "=", command.userId)
      .execute();
    await database
      .updateTable("owner_state")
      .set({
        version: state.version + 1,
        permission_version: state.permission_version + 1,
      })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: state.version + 1 };
  });
}

export function transferOwnership(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal,
  command: z.infer<typeof TransferOwnershipSchema>,
): Promise<AdministrationOutcome> {
  return storage.transaction(async () => {
    const authorized = await ownerAccess(database, principal);
    if (authorized.kind !== "authorized") return authorized;
    const { state } = authorized;
    if (state.version !== command.expectedVersion)
      return { kind: "stale_version", currentVersion: state.version };
    if (command.userId === principal.userId) return { kind: "invalid_input" };
    if (!(await membership(database, command.userId)))
      return { kind: "not_found" };
    // The partial unique index prevents two owners. The native transaction
    // prevents observers or failures from exposing the intermediate zero-owner state.
    await database
      .updateTable("members")
      .set({ role: "member" })
      .where("user_id", "=", principal.userId)
      .execute();
    await database
      .updateTable("members")
      .set({ role: "owner" })
      .where("user_id", "=", command.userId)
      .execute();
    await database
      .updateTable("owner_state")
      .set({
        version: state.version + 1,
        permission_version: state.permission_version + 1,
      })
      .where("id", "=", 1)
      .execute();
    return { kind: "changed", version: state.version + 1 };
  });
}
