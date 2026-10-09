import type { MessageDO } from "@/server/actors/shared/message-do";
import type { Principal } from "@/server/domain/principal";
import type { MessagingOutcome } from "@vaskel/contracts/messaging";
import { expect } from "vitest";
import { applicationSocket } from "@tests/helpers/application-harness";

export async function nativeSocket(
  owner: DurableObjectStub<MessageDO>,
  channelId: string,
  member: Principal,
  ticket?: Extract<MessagingOutcome, { kind: "socket_ticket" }>,
) {
  const prepared = ticket ?? (await owner.prepareSocket(member, { channelId }));
  if (prepared.kind !== "socket_ticket") throw new Error("Expected ticket");
  const request = () =>
    new Request("https://vaskel.test/events", {
      headers: {
        Upgrade: "websocket",
        "X-Vaskel-User-Id": member.userId,
        "X-Vaskel-Session-Id": member.sessionId,
        "X-Vaskel-Assertion-Expires-At": String(member.expiresAt),
        "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${prepared.ticket}`,
      },
    });
  const response = await owner.fetch(request());
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe("vaskel-v1");
  return { ...(await applicationSocket(response)), request, prepared };
}
