import { describe, expect, it } from "vitest";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { applicationHarness } from "@tests/helpers/application-harness";
import { openAccountEvents } from "@tests/helpers/event-dispatch-harness";

describe("circle administration directory events", () => {
  it("invalidates directory after each settings, role, channel and ownership commit", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const first = await h.createServer(operator);
    const alice = await h.registerMember(operator, first.owner.id);
    const stream = await openAccountEvents(alice.member);
    const version = async () => {
      const result = DirectoryOutcomeSchema.parse(
        await (await operator.request(first.path)).json(),
      );
      if (result.kind !== "directory") throw new Error(result.kind);
      return result.version;
    };
    const directoryCount = () =>
      stream.frames.filter(
        (frame) =>
          frame.type === "directory" && frame.owner.id === first.owner.id,
      ).length;
    async function change(route: string, body: object) {
      await stream.sync();
      const count = directoryCount();
      expect(
        (
          await operator.request(`/api/servers/${first.owner.id}/${route}`, {
            ...body,
            expectedVersion: await version(),
          })
        ).status,
      ).toBe(200);
      await stream.sync();
      await expect.poll(directoryCount).toBe(count + 1);
    }
    try {
      await change("settings", { membersMayInvite: false });
      await change("set-role", {
        userId: alice.registered.userId,
        role: "moderator",
      });
      await change("channels", {
        channelId: crypto.randomUUID(),
        name: "Private",
        private: true,
      });
      await change("transfer", { userId: alice.registered.userId });
    } finally {
      await stream.close();
    }
  });
});
