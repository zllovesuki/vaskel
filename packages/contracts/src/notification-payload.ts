import * as z from "zod/mini";
import { OwnerScopeSchema } from "./owner-scope";

/** One wire schema for encryption and browser display, without management code. */
export const NotificationPayloadSchema = z.strictObject({
  accountId: z.uuid(),
  title: z.string().check(z.maxLength(250)),
  body: z.string().check(z.maxLength(600)),
  tag: z.string().check(z.maxLength(200)),
  owner: z.nullable(OwnerScopeSchema),
  roomId: z.nullable(z.uuid()),
  messageId: z.nullable(z.uuid()),
});
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;
