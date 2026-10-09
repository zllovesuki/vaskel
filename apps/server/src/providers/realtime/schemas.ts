import { z } from "zod";

export const publicErrorSchema = z.object({
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
});

const sessionDescriptionSchema = z.object({
  type: z.enum(["offer", "answer"]),
  sdp: z.string(),
});
const trackSchema = z.object({
  mid: z.string().optional(),
  sessionId: z.string().optional(),
  trackName: z.string().optional(),
  location: z.enum(["local", "remote"]).optional(),
  kind: z.enum(["audio", "video"]).optional(),
  errorCode: z.string().optional(),
  errorDescription: z.string().optional(),
});

export const newSessionSchema = z.object({ sessionId: z.string().min(1) });
export const tracksResponseSchema = z.object({
  sessionDescription: sessionDescriptionSchema.optional(),
  tracks: z.array(trackSchema).default([]),
  requiresImmediateRenegotiation: z.boolean().default(false),
});
export const sessionStateSchema = z.object({
  tracks: z
    .array(
      trackSchema.extend({
        status: z.enum(["active", "inactive", "waiting"]).optional(),
      }),
    )
    .default([]),
});
