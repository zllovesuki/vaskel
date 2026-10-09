import { readHttpFailure } from "@tests/helpers/http";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ResourceCreatedSchema,
  ResourceDirectorySchema,
} from "@vaskel/contracts/directory";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import {
  applicationHarness,
  decodeApplicationResponse,
  resourcePath,
} from "@tests/helpers/application-harness";

describe("room and server metadata through HTTP", () => {
  it("creates a named first room and recovers creation receipts after both names change", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const command = {
      commandId: crypto.randomUUID(),
      name: "友達の集まり",
      firstChannelName: "  おしゃべり  ",
    };
    const created = await decodeApplicationResponse(
      await operator.request("/api/servers", command),
      ResourceCreatedSchema,
    );
    if (created.kind !== "created") throw new Error("Creation failed.");
    const path = resourcePath(created.owner);
    const directory = await decodeApplicationResponse(
      await operator.request(path),
      DirectoryOutcomeSchema,
    );
    if (directory.kind !== "directory") throw new Error("Directory failed.");
    expect(directory.channels).toEqual([
      {
        id: created.channelId,
        occupancy: null,
        name: "おしゃべり",
        private: false,
        kind: "text",
        version: 1,
        topic: null,
        position: 0,
      },
    ]);
    expect(
      await decodeApplicationResponse(
        await operator.request(
          `/api/servers/${created.owner.id}/update-channel`,
          {
            channelId: created.channelId,
            name: "雑談",
            topic: "こんにちは",
            expectedVersion: 1,
          },
        ),
        AdministrationOutcomeSchema,
      ),
    ).toEqual({ kind: "changed", version: 2 });
    expect(
      await decodeApplicationResponse(
        await operator.request(`/api/servers/${created.owner.id}/rename`, {
          name: "新しい集まり",
          expectedVersion: 2,
        }),
        AdministrationOutcomeSchema,
      ),
    ).toEqual({ kind: "changed", version: 3 });
    expect(
      await decodeApplicationResponse(
        await operator.request("/api/servers", command),
        ResourceCreatedSchema,
      ),
    ).toEqual(created);
    expect(
      await readHttpFailure(
        await operator.request("/api/servers", {
          ...command,
          firstChannelName: "別の名前",
        }),
      ),
    ).toMatchObject({ code: "COMMAND_CONFLICT" });
    const resources = await decodeApplicationResponse(
      await operator.request("/api/directory"),
      ResourceDirectorySchema,
    );
    if (resources.kind !== "directory") throw new Error("Directory failed.");
    expect(resources.resources[0]).toMatchObject({
      name: "新しい集まり",
      channels: [{ name: "雑談", topic: "こんにちは" }],
    });
    expect(
      (
        await operator.request("/api/servers", {
          ...command,
          commandId: crypto.randomUUID(),
          firstChannelName: "  ",
        })
      ).status,
    ).toBe(400);
    const fallback = await h.createServer(operator, "Default room");
    expect(
      await decodeApplicationResponse(
        await operator.request(fallback.path),
        DirectoryOutcomeSchema,
      ),
    ).toMatchObject({
      channels: [{ name: "general" }],
    });
  });

  it("orders rooms, clears topics, rejects stale and unauthorized edits, and rolls back an interrupted change", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member } = await h.registerMember(operator, server.owner.id);
    const initial = await decodeApplicationResponse(
      await operator.request(server.path),
      DirectoryOutcomeSchema,
    );
    if (initial.kind !== "directory") throw new Error("Directory failed.");
    const otherId = crypto.randomUUID();
    expect(
      await decodeApplicationResponse(
        await operator.request(`/api/servers/${server.owner.id}/channels`, {
          channelId: otherId,
          name: "Second",
          kind: "text",
          private: false,
          expectedVersion: initial.version,
        }),
        AdministrationOutcomeSchema,
      ),
    ).toMatchObject({ kind: "changed" });
    const route = `/api/servers/${server.owner.id}/update-channel`;
    expect(
      (
        await member.request(route, {
          channelId: otherId,
          name: "Denied",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.request(`/api/servers/${server.owner.id}/rename`, {
          name: "Denied",
          expectedVersion: 1,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await operator.request(route, {
          channelId: otherId,
          expectedVersion: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      await decodeApplicationResponse(
        await operator.request(route, {
          channelId: server.channelId,
          topic: "A topic",
          position: 10,
          expectedVersion: 1,
        }),
        AdministrationOutcomeSchema,
      ),
    ).toEqual({ kind: "changed", version: 2 });
    expect(
      await decodeApplicationResponse(
        await operator.request(route, {
          channelId: server.channelId,
          topic: null,
          expectedVersion: 2,
        }),
        AdministrationOutcomeSchema,
      ),
    ).toEqual({ kind: "changed", version: 3 });
    const ordered = await decodeApplicationResponse(
      await operator.request(server.path),
      DirectoryOutcomeSchema,
    );
    if (ordered.kind !== "directory") throw new Error("Directory failed.");
    expect(ordered.channels.map((channel) => channel.id)).toEqual([
      otherId,
      server.channelId,
    ]);
    expect(ordered.channels[1]).toMatchObject({
      topic: null,
      position: 10,
      version: 3,
    });
    expect(
      await readHttpFailure(
        await operator.request(route, {
          channelId: server.channelId,
          topic: "stale",
          expectedVersion: 2,
        }),
      ),
    ).toMatchObject({
      code: "STALE_VERSION",
      data: { kind: "stale_version", currentVersion: 3 },
    });
    expect(
      await readHttpFailure(
        await operator.request(`/api/servers/${server.owner.id}/rename`, {
          name: "stale",
          expectedVersion: 1,
        }),
      ),
    ).toMatchObject({
      code: "STALE_VERSION",
      data: { kind: "stale_version", currentVersion: ordered.version },
    });

    const stub = h.environment.SERVER_DO.getByName(server.owner.id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER fixture_metadata_abort BEFORE UPDATE ON owner_state BEGIN SELECT RAISE(ABORT, 'fixture metadata interruption'); END",
      );
    });
    try {
      expect(
        (
          await operator.request(route, {
            channelId: otherId,
            name: "Must roll back",
            expectedVersion: 1,
          })
        ).status,
      ).toBe(500);
    } finally {
      await runInDurableObject(stub, async (_instance, state) => {
        state.storage.sql.exec("DROP TRIGGER fixture_metadata_abort");
      });
    }
    const after = await decodeApplicationResponse(
      await operator.request(server.path),
      DirectoryOutcomeSchema,
    );
    expect(after).toEqual(ordered);
    const results = await Promise.all(
      ["First edit", "Competing edit"].map(async (name) => {
        const response = await operator.request(route, {
          channelId: otherId,
          name,
          expectedVersion: 1,
        });
        if (!response.ok) {
          const error = await readHttpFailure(response);
          expect(error).toMatchObject({
            code: "STALE_VERSION",
            data: { kind: "stale_version", currentVersion: 2 },
          });
          return error.code;
        }
        const result = await decodeApplicationResponse(
          response,
          AdministrationOutcomeSchema,
        );
        expect(result).toMatchObject({ kind: "changed" });
        return result.kind;
      }),
    );
    expect(results.sort()).toEqual(["STALE_VERSION", "changed"]);
  });
});
