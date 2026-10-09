import { z } from "zod";
import { MediaRoomRefSchema } from "./media";

export const MediaSnapshotRequestSchema = z.strictObject({
  room: MediaRoomRefSchema,
});

export const MediaConfigurationSchema = z.strictObject({
  kind: z.literal("media_configuration"),
  configured: z.boolean(),
  maxParticipants: z.literal(16),
});
