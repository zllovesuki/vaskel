import type { Page, Route } from "@playwright/test";
import {
  AckMediaRequestSchema,
  PublishMediaRequestSchema,
  JoinMediaRequestSchema,
  ResumeMediaRequestSchema,
  LeaveMediaRequestSchema,
  MediaOutcomeSchema,
  ModerateMediaRequestSchema,
  type JoinMediaRequest,
  type ResumeMediaRequest,
  type LeaveMediaRequest,
  type MediaOutcome,
  type MediaSnapshot,
  type ModerateMediaRequest,
} from "@vaskel/contracts/media";
import { MediaConfigurationSchema } from "@vaskel/contracts/media-http";
import {
  type Account,
  type BrowserApplication,
  type Room,
} from "@tests/e2e/fixtures";
import { apiErrorResponse, deferred } from "@tests/e2e/helpers";

/**
 * Real built React, identity, directory and messaging; synthetic media outcomes.
 * Muted startup negotiates with a native loopback receiver; signaling stays local.
 * These cases establish control reachability, not live media delivery.
 */
export async function syntheticMedia(
  page: Page,
  app: BrowserApplication,
  account: Account,
  room: Room,
  mode: "held" | "failed" | "joined",
) {
  const release = deferred();
  const state = {
    mode,
    joins: [] as JoinMediaRequest[],
    resumes: [] as ResumeMediaRequest[],
    leaves: [] as LeaveMediaRequest[],
    moderations: [] as ModerateMediaRequest[],
    unexpected: [] as string[],
    joined: false,
    heartbeats: 0,
    snapshots: 0,
    revision: 1,
    participants: [] as MediaSnapshot["participants"],
    publications: [] as MediaSnapshot["participants"][number]["publications"],
    producerVersion: 0,
    generation: 1,
    release: release.resolve,
  };
  await page.addInitScript(
    ({ origin, userId }) => {
      const navigation = performance.getEntriesByType("navigation")[0] as
        PerformanceNavigationTiming | undefined;
      if (
        location.origin === origin &&
        navigation?.type !== "reload" &&
        sessionStorage.getItem(`vaskel:call:${origin}:${userId}:muted`) === null
      )
        sessionStorage.setItem(`vaskel:call:${origin}:${userId}:muted`, "true");
    },
    { origin: app.origin, userId: account.profile.userId },
  );
  const snapshot = (): MediaSnapshot => ({
    room: { owner: room.owner, channelId: room.channelId },
    revision: state.joined ? state.revision : 0,
    participants: state.joined
      ? [
          {
            id: "browser-participant",
            userId: account.profile.userId,
            generation: state.generation,
            controlVersion: 0,
            muted: false,
            deafened: false,
            screenRevoked: false,
            status: "active",
            publications: [...state.publications],
          },
          ...state.participants,
        ]
      : [],
  });
  const fulfill = (route: Route, outcome: MediaOutcome) => {
    if (outcome.kind === "unavailable")
      return route.fulfill(apiErrorResponse("UNAVAILABLE"));
    if (outcome.kind === "provider_error")
      return route.fulfill(apiErrorResponse("PROVIDER_ERROR", outcome));
    if (outcome.kind === "moderation_changed")
      return route.fulfill(apiErrorResponse("MODERATION_CHANGED", outcome));
    return route.fulfill({ json: MediaOutcomeSchema.parse(outcome) });
  };
  await page.route("**/api/media/**", async (route) => {
    const operation = new URL(route.request().url()).pathname.split("/").at(-1);
    if (operation === "config")
      return route.fulfill({
        json: MediaConfigurationSchema.parse({
          kind: "media_configuration",
          configured: true,
          maxParticipants: 16,
        }),
      });
    if (operation === "status")
      return fulfill(route, {
        kind: "media_status",
        generation: 0,
        admission: { kind: "available" },
      });
    if (operation === "snapshot") {
      state.snapshots++;
      return fulfill(route, { kind: "media_snapshot", snapshot: snapshot() });
    }
    if (operation === "join") {
      const command = JoinMediaRequestSchema.parse(
        route.request().postDataJSON(),
      );
      state.joins.push(command);
      if (state.mode === "held") {
        await release.promise;
        // Leave correctly aborts the pending fetch; a late result cannot rejoin.
        try {
          await fulfill(route, { kind: "unavailable" });
        } catch (error) {
          if (
            !/Target closed|Target page|Invalid InterceptionId|already handled/.test(
              String(error),
            )
          )
            throw error;
        }
        return;
      }
      if (state.mode === "failed")
        return fulfill(route, {
          kind: "provider_error",
          code: "browser-synthetic-unavailable",
          retryable: true,
          uncertain: false,
        });
      state.joined = true;
      return fulfill(route, {
        kind: "joined",
        handle: {
          room: command.room,
          participantId: "browser-participant",
          accountGeneration: 1,
          clientId: command.clientId,
          deviceToken: command.deviceToken,
        },
        generation: 1,
        producerVersion: 0,
        consumerVersion: 0,
        snapshot: snapshot(),
      });
    }
    if (operation === "publish") {
      const request = PublishMediaRequestSchema.parse(
        route.request().postDataJSON(),
      );
      const sessionDescription = await page.evaluate(async (offer) => {
        const peer = (window.uiMediaReceiver ??= new RTCPeerConnection({
          iceServers: [],
        }));
        await peer.setRemoteDescription(offer);
        await peer.setLocalDescription(await peer.createAnswer());
        if (peer.iceGatheringState !== "complete")
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Loopback ICE did not complete")),
              5000,
            );
            peer.addEventListener("icegatheringstatechange", () => {
              if (peer.iceGatheringState === "complete") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
        return { type: "answer" as const, sdp: peer.localDescription!.sdp };
      }, request.sessionDescription);
      state.publications = request.tracks.map(({ source }) => ({
        id: crypto.randomUUID(),
        participantId: "browser-participant",
        generation: state.generation,
        source,
      }));
      state.revision++;
      return fulfill(route, {
        kind: "negotiation",
        operationId: request.operationId,
        sessionVersion: ++state.producerVersion,
        phase: "awaiting_apply",
        sessionDescription,
        publications: state.publications,
        subscriptions: [],
        deadline: Date.now() + 15_000,
      });
    }
    if (operation === "resume") {
      const command = ResumeMediaRequestSchema.parse(
        route.request().postDataJSON(),
      );
      state.resumes.push(command);
      state.generation = command.handle.accountGeneration + 1;
      state.producerVersion = 0;
      state.publications = [];
      state.revision++;
      state.joined = true;
      return fulfill(route, {
        kind: "joined",
        handle: {
          ...command.handle,
          accountGeneration: state.generation,
          deviceToken: command.nextDeviceToken,
        },
        generation: state.generation,
        producerVersion: 0,
        consumerVersion: 0,
        snapshot: snapshot(),
      });
    }
    if (operation === "ack") {
      const request = AckMediaRequestSchema.parse(
        route.request().postDataJSON(),
      );
      return fulfill(route, {
        kind: "completed",
        operationId: request.operationId,
        sessionVersion: state.producerVersion,
        revision: state.revision,
      });
    }
    if (operation === "leave") {
      state.leaves.push(
        LeaveMediaRequestSchema.parse(route.request().postDataJSON()),
      );
      state.joined = false;
      await page.evaluate(() => window.uiMediaReceiver?.close());
      return fulfill(route, {
        kind: "left",
        generation: 1,
        cleanupPending: false,
      });
    }
    if (operation === "moderate") {
      const command = ModerateMediaRequestSchema.parse(
        route.request().postDataJSON(),
      );
      state.moderations.push(command);
      const target = state.participants.find(
        (p) => p.userId === command.userId,
      );
      if (
        !target ||
        target.generation !== command.participantGeneration ||
        target.controlVersion !== command.expectedControlVersion
      )
        return fulfill(route, { kind: "moderation_changed" });
      if (command.action === "remove")
        state.participants = state.participants.filter((p) => p !== target);
      else {
        target.controlVersion++;
        if (command.action === "mute") target.muted = command.enabled;
        else if (command.action === "deafen") target.deafened = command.enabled;
        else target.screenRevoked = command.enabled;
      }
      state.revision++;
      return fulfill(route, {
        kind: "moderated",
        revision: state.revision,
        cleanupPending: false,
      });
    }
    if (operation === "heartbeat") {
      state.heartbeats++;
      return fulfill(route, {
        kind: "heartbeat",
        expiresAt: Date.now() + 60_000,
        snapshot: snapshot(),
      });
    }
    state.unexpected.push(operation ?? "missing operation");
    return fulfill(route, { kind: "unavailable" });
  });
  return state;
}
declare global {
  interface Window {
    uiMediaReceiver?: RTCPeerConnection;
  }
}
