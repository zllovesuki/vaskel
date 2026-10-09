import { mediaErrors } from "./errors";
import { z } from "zod";
import { operation, empty, sessionSecurity } from "./base";
import { outcome } from "./outcome";
import {
  AckMediaRequestSchema,
  AnswerMediaRequestSchema,
  HeartbeatMediaRequestSchema,
  JoinMediaRequestSchema,
  LeaveMediaRequestSchema,
  MediaOutcomeSchema,
  ModerateMediaRequestSchema,
  PublishMediaRequestSchema,
  ResumeMediaRequestSchema,
  SubscribeMediaRequestSchema,
  UnpublishMediaRequestSchema,
} from "../media";
import {
  MediaConfigurationSchema,
  MediaSnapshotRequestSchema,
} from "../media-http";
const media = operation
  .errors(mediaErrors)
  .route({ spec: (spec) => ({ ...spec, security: sessionSecurity }) })
  .meta({ authority: "media" });
export const mediaApiContract = {
  mediaConfig: media
    .route({ method: "GET", path: "/media/config" })
    .input(empty)
    .output(MediaConfigurationSchema),
  mediaStatus: media
    .route({ method: "GET", path: "/media/status", inputStructure: "detailed" })
    .input(empty)
    .output(outcome(MediaOutcomeSchema, "media_status")),
  joinMedia: media
    .route({ method: "POST", path: "/media/join", inputStructure: "detailed" })
    .input(z.object({ body: JoinMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "joined")),
  transferMedia: media
    .route({
      method: "POST",
      path: "/media/transfer",
      inputStructure: "detailed",
    })
    .input(z.object({ body: JoinMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "joined")),
  resumeMedia: media
    .route({
      method: "POST",
      path: "/media/resume",
      inputStructure: "detailed",
    })
    .input(z.object({ body: ResumeMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "joined")),
  leaveMedia: media
    .meta({ authority: "cleanup" })
    .route({ method: "POST", path: "/media/leave", inputStructure: "detailed" })
    .input(z.object({ body: LeaveMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "left", "cleanup_pending")),
  mediaSnapshot: media
    .route({
      method: "POST",
      path: "/media/snapshot",
      inputStructure: "detailed",
    })
    .input(z.object({ body: MediaSnapshotRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "media_snapshot")),
  heartbeatMedia: media
    .route({
      method: "POST",
      path: "/media/heartbeat",
      inputStructure: "detailed",
    })
    .input(z.object({ body: HeartbeatMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "heartbeat")),
  publishMedia: media
    .route({
      method: "POST",
      path: "/media/publish",
      inputStructure: "detailed",
    })
    .input(z.object({ body: PublishMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "negotiation", "completed")),
  ackMedia: media
    .route({ method: "POST", path: "/media/ack", inputStructure: "detailed" })
    .input(z.object({ body: AckMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "completed")),
  subscribeMedia: media
    .route({
      method: "POST",
      path: "/media/subscribe",
      inputStructure: "detailed",
    })
    .input(z.object({ body: SubscribeMediaRequestSchema }))
    .output(
      outcome(MediaOutcomeSchema, "negotiation", "completed").refine(
        (result) =>
          result.kind !== "completed" || result.subscriptions !== undefined,
        {
          message: "Consumer completion requires subscriptions",
          path: ["subscriptions"],
        },
      ),
    ),
  answerMedia: media
    .route({
      method: "POST",
      path: "/media/answer",
      inputStructure: "detailed",
    })
    .input(z.object({ body: AnswerMediaRequestSchema }))
    .output(
      outcome(MediaOutcomeSchema, "completed", "negotiation").refine(
        (result) =>
          result.kind !== "completed" || result.subscriptions !== undefined,
        {
          message: "Consumer completion requires subscriptions",
          path: ["subscriptions"],
        },
      ),
    ),
  unpublishMedia: media
    .route({
      method: "POST",
      path: "/media/unpublish",
      inputStructure: "detailed",
    })
    .input(z.object({ body: UnpublishMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "negotiation", "completed")),
  moderateMedia: media
    .route({
      method: "POST",
      path: "/media/moderate",
      inputStructure: "detailed",
    })
    .input(z.object({ body: ModerateMediaRequestSchema }))
    .output(outcome(MediaOutcomeSchema, "moderated")),
};
