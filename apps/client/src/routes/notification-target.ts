import * as z from "zod/mini";
import { NotificationPayloadSchema } from "@vaskel/contracts/notification-payload";
import { resourceLocation } from "./resource-location";

export const NotificationTargetSchema = z
  .pick(NotificationPayloadSchema, {
    accountId: true,
    owner: true,
    roomId: true,
  })
  .check(
    z.refine((target) => (target.owner === null) === (target.roomId === null)),
  );

/** No provider-supplied URL is ever used as a navigation destination. */
export function notificationReturnPath(value: unknown): string {
  const parsed = NotificationTargetSchema.safeParse(value);
  if (!parsed.success) return "/";
  const { accountId, owner, roomId } = parsed.data;
  const base = `/notifications/${encodeURIComponent(accountId)}`;
  return owner && roomId
    ? `${base}/${owner.kind}/${encodeURIComponent(owner.id)}/${encodeURIComponent(roomId)}`
    : base;
}

/** Authentication and current access still belong to the ordinary entry/workspace. */
export function notificationReturnDecision(
  value: unknown,
  accountId: string | null,
) {
  const parsed = NotificationTargetSchema.safeParse(value);
  if (!parsed.success) return { kind: "invalid" } as const;
  if (!accountId) return { kind: "sign-in" } as const;
  if (parsed.data.accountId !== accountId)
    return { kind: "other-account" } as const;
  const { owner, roomId } = parsed.data;
  return {
    kind: "open",
    location:
      owner && roomId ? resourceLocation(owner, roomId) : { to: "/" as const },
  } as const;
}
