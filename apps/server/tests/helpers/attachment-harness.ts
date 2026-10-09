import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { expect } from "vitest";
import {
  AttachmentGrantSchema,
  AttachmentOutcomeSchema,
} from "@vaskel/contracts/attachments";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { fixtureAuthVars } from "../../../../tests/config/bindings";
import {
  applicationHarness,
  applicationSocket,
  decodeApplicationResponse,
  type ApplicationClient,
} from "@tests/helpers/application-harness";

export function attachmentHarness() {
  const h = applicationHarness();
  // Report only whether the deterministic fixture is active, never binding values.
  expect(
    Object.entries(fixtureAuthVars).every(
      ([name, value]) =>
        h.environment[name as keyof typeof fixtureAuthVars] === value,
    ),
    "Attachment tests require isolated public fixture bindings",
  ).toBe(true);

  async function put(
    client: ApplicationClient,
    path: string,
    bytes: Uint8Array,
  ) {
    const headers = new Headers({
      Origin: h.environment.AUTH_ORIGIN,
      Cookie: client.cookie,
      "CF-Connecting-IP": client.address,
      "Content-Type": "application/octet-stream",
    });
    if (client.bookmark) headers.set("X-Vaskel-D1-Bookmark", client.bookmark);
    const execution = createExecutionContext();
    const response = await h.app.request(
      `${h.environment.AUTH_ORIGIN}${path}`,
      { method: "PUT", headers, body: bytes },
      h.environment,
      execution,
    );
    await waitOnExecutionContext(execution);
    const bookmark = response.headers.get("X-Vaskel-D1-Bookmark");
    if (bookmark) client.bookmark = bookmark;
    return response;
  }

  async function reserve(
    client: ApplicationClient,
    path: string,
    channelId: string,
    filename: string,
    byteLength: number,
  ) {
    const command = {
      commandId: crypto.randomUUID(),
      issuedAt: Date.now(),
      channelId,
      filename,
      byteLength,
    };
    const result = await attachmentResult(
      await client.request(`${path}/files/reserve`, command),
    );
    if (result.kind !== "attachment_reserved")
      throw new Error(`Reservation failed: ${result.kind}`);
    return { ...result, command, path: `${path}/files/${result.fileId}` };
  }

  async function upload(
    client: ApplicationClient,
    path: string,
    channelId: string,
    filename: string,
    bytes: Uint8Array,
  ) {
    const reservation = await reserve(
      client,
      path,
      channelId,
      filename,
      bytes.byteLength,
    );
    const result = await attachmentResult(
      await put(client, `${reservation.path}/content`, bytes),
    );
    if (result.kind !== "attachment_ready")
      throw new Error(`Upload failed: ${result.kind}`);
    return { ...reservation, attachment: result.attachment, bytes };
  }

  /** The grant is the authorized step; the byte request then carries only the token. */
  async function grant(client: ApplicationClient, path: string) {
    return decodeApplicationResponse(
      await client.request(`${path}/grant`),
      AttachmentGrantSchema,
    );
  }

  async function download(
    client: ApplicationClient,
    path: string,
    options?: Parameters<ApplicationClient["request"]>[2],
  ) {
    const { url } = await grant(client, path);
    return client.request(url, undefined, options);
  }

  async function socket(
    client: ApplicationClient,
    path: string,
    channelId: string,
  ) {
    const ticket = await messagingResult(
      await client.request(`${path}/socket-ticket`, { channelId }),
    );
    if (ticket.kind !== "socket_ticket")
      throw new Error(`Socket ticket failed: ${ticket.kind}`);
    return applicationSocket(
      await client.request(`${path}/socket`, undefined, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${ticket.ticket}`,
        },
      }),
    );
  }
  return { ...h, put, reserve, upload, grant, download, socket };
}

export async function attachmentResult(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return decodeApplicationResponse(response, AttachmentOutcomeSchema);
}

export async function messagingResult(response: Response, status = 200) {
  expect(response.status).toBe(status);
  return decodeApplicationResponse(response, MessagingOutcomeSchema);
}
