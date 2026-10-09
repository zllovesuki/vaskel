import { describe, expect, it } from "vitest";
import {
  applicationHarness,
  messageCommand,
} from "@tests/helpers/application-harness";
import { readHttpFailure } from "@tests/helpers/http";

describe("contract HTTP ingress", () => {
  it("rejects malformed JSON and invalid commands before actor dispatch", async () => {
    const h = applicationHarness();
    const user = await h.bootstrap();
    const server = await h.createServer(user);
    for (const rawBody of [
      "{",
      "",
      "null",
      JSON.stringify({ channelId: server.channelId }),
    ]) {
      const response = await user.request(`${server.path}/send`, undefined, {
        method: "POST",
        rawBody,
      });
      expect(response.status).toBe(400);
      expect(await readHttpFailure(response)).toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    const text = await user.request(
      `${server.path}/send`,
      messageCommand(server.channelId),
      { headers: { "Content-Type": "text/plain" } },
    );
    expect(text.status).toBe(400);
  });

  it("bounds credential and application bodies before decoding", async () => {
    const h = applicationHarness();
    const credentials = await h.anonymous.request("/api/identity/sign-in", {
      email: "a@example.invalid",
      password: "x".repeat(8192),
    });
    expect(credentials.status).toBe(413);
    expect(await readHttpFailure(credentials)).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
    const user = await h.bootstrap();
    const server = await h.createServer(user);
    const command = await user.request(`${server.path}/send`, {
      ...messageCommand(server.channelId),
      body: "x".repeat(256 * 1024),
    });
    expect(command.status).toBe(413);
    expect(await readHttpFailure(command)).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    });
  });

  it("validates input before resolving owners and retains authentication for valid requests", async () => {
    const h = applicationHarness();
    expect(
      (
        await h.anonymous.request("/api/account/preferences", {
          language: "ja",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await h.anonymous.request("/api/account/preferences", undefined, {
          rawBody: "{",
        })
      ).status,
    ).toBe(400);
    const user = await h.bootstrap();
    const missing = `/api/resources/server/${crypto.randomUUID()}`;
    expect(
      (await user.request(`${missing}/snapshot`, undefined, { rawBody: "{" }))
        .status,
    ).toBe(400);
    expect(
      await readHttpFailure(
        await user.request(`${missing}/snapshot`, { channelId: "general" }),
      ),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await readHttpFailure(
        await user.request(`${missing}/original-message`, {
          channelId: "general",
          messageId: crypto.randomUUID(),
        }),
      ),
    ).toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    const cursor = crypto.randomUUID();
    const repeated = await user.request(
      `/api/directory?after=${cursor}&after=${cursor}`,
    );
    expect(await readHttpFailure(repeated)).toMatchObject({
      code: "BAD_REQUEST",
    });
    const invalid = await user.request("/api/directory?after=invalid");
    expect(invalid.status).toBe(400);
    expect(await readHttpFailure(invalid)).toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
