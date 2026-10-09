import type { NotificationMessageReference } from "@/server/notifications/protocol";
import { DurableObject } from "cloudflare:workers";
import type {
  NotificationCommand,
  NotificationOutcome,
} from "@vaskel/contracts/notifications";
import type { Principal } from "@/server/domain/principal";
import { principalFailure } from "@/server/actors/shared/policy";
import {
  actorWork,
  ACTOR_WORK_BUDGET_MS,
} from "@/server/actors/shared/bounded-work";
import { eventDispatchStub } from "@/server/event-dispatch/routing";
import { createVapidKeys } from "@/server/notifications/web-push";
import { logEvent } from "@/server/telemetry";
import {
  accountState,
  defaultPreferences,
  notificationDatabase,
  publicState,
  subscriptionOf,
} from "./store";
import { applyCommand } from "./commands";
import { consumeDue, offerMessage, refreshSchedule } from "./scheduling";
import { dispatchGroup } from "./dispatch";

/** Account-owned enrollment, preferences and waiting; no delivery-time identity reads. */
export class NotificationDO extends DurableObject<Env> {
  private readonly database;
  private offersEnabled = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.database = notificationDatabase(ctx.storage, ctx.id.toString());
    this.refreshOfferState();
  }
  private refreshOfferState() {
    // Read and assign synchronously after commits, never from an older command result.
    this.offersEnabled = !this.ctx.storage.sql
      .exec(
        `SELECT 1 FROM notification_account WHERE id = 1
        AND NOT json_extract(preferences_json, '$.paused')
        AND EXISTS (SELECT 1 FROM notification_devices)`,
      )
      .next().done;
  }
  private async initialize(principal: Principal) {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    if (!(await accountState(this.database))) {
      const keys = await createVapidKeys();
      await this.ctx.storage.transaction(async () => {
        if (!(await accountState(this.database)))
          await this.database
            .insertInto("notification_account")
            .values({
              id: 1,
              account_id: principal.userId,
              revision: 0,
              preferences_json: JSON.stringify(defaultPreferences),
              vapid_json: JSON.stringify(keys),
            })
            .execute();
      });
    }
    return principalFailure(principal);
  }
  async status(principal: Principal): Promise<NotificationOutcome> {
    const invalid = await this.initialize(principal);
    if (invalid) return invalid;
    return this.ctx.storage.transaction(async () => {
      const expired = principalFailure(principal);
      return (
        expired ?? {
          kind: "notification_state",
          state: await publicState(this.database),
        }
      );
    });
  }
  async command(
    principal: Principal,
    command: NotificationCommand,
  ): Promise<NotificationOutcome> {
    const invalid = await this.initialize(principal);
    if (invalid) return invalid;
    const result = await applyCommand(
      this.ctx.storage,
      this.database,
      principal,
      command,
    );
    if (
      result.outcome.kind === "notification_updated" &&
      (command.kind === "enable" ||
        command.kind === "remove" ||
        command.kind === "preferences")
    )
      this.refreshOfferState();
    if (result.outcome.kind === "notification_updated")
      this.ctx.waitUntil(this.announceSettings(principal.userId));
    if (result.testDevice)
      this.ctx.waitUntil(
        dispatchGroup(
          this.ctx,
          this.env,
          this.database,
          "",
          [],
          result.testDevice,
        ).catch(() => {
          logEvent("warn", "notification_dispatch_failed", {
            actorId: this.ctx.id.toString(),
          });
        }),
      );
    return result.outcome;
  }
  /** Open tabs re-read settings they decide message sounds with; best effort. */
  private async announceSettings(accountId: string) {
    const result = await actorWork(this.ctx.storage, "hints").run(async () => {
      const outcome = await eventDispatchStub(this.env, accountId).deliver({
        recipients: [accountId],
        notice: { type: "notification_settings" },
      });
      if (outcome.kind !== "delivered") throw new Error(outcome.kind);
    }, Date.now() + ACTOR_WORK_BUDGET_MS);
    if (!result.ok)
      logEvent("warn", "event_hint_delivery_failed", {
        actorId: this.ctx.id.toString(),
      });
  }
  async offerCommittedMessage(reference: NotificationMessageReference) {
    if (this.offersEnabled)
      await offerMessage(this.ctx.storage, this.database, reference);
  }
  async removeDeadSubscription(
    deviceId: string,
    subscriptionVersion: number,
    endpoint: string,
  ) {
    await this.ctx.storage.transaction(async () => {
      const device = await this.database
        .selectFrom("notification_devices")
        .selectAll()
        .where("device_id", "=", deviceId)
        .executeTakeFirst();
      if (
        !device ||
        device.version !== subscriptionVersion ||
        subscriptionOf(device).endpoint !== endpoint
      )
        return;
      await this.database
        .deleteFrom("notification_devices")
        .where("device_id", "=", deviceId)
        .execute();
      const state = (await accountState(this.database))!;
      await this.database
        .updateTable("notification_account")
        .set({ revision: state.revision + 1 })
        .where("id", "=", 1)
        .execute();
    });
    this.refreshOfferState();
  }
  override async alarm() {
    const groups = await consumeDue(this.ctx.storage, this.database);
    try {
      await Promise.all(
        groups.map((group) =>
          dispatchGroup(
            this.ctx,
            this.env,
            this.database,
            group.room_key,
            JSON.parse(group.references_json) as NotificationMessageReference[],
          ).catch(() => {
            logEvent("warn", "notification_dispatch_failed", {
              actorId: this.ctx.id.toString(),
            });
          }),
        ),
      );
    } finally {
      await this.ctx.storage.transaction(() =>
        refreshSchedule(this.ctx.storage, this.database),
      );
    }
  }
}
