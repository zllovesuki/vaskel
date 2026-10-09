import { describe, expect, it } from "vitest";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import {
  conversationCounterparts,
  conversationTitle,
  titledResource,
} from "@/client/features/workspace/conversation-title";

const me = "00000000-0000-4000-8000-000000000001";
const li = "00000000-0000-4000-8000-000000000002";
const mika = "00000000-0000-4000-8000-000000000003";
const conversation: ResourceSummary = {
  owner: { kind: "conversation", id: "dm" },
  name: "Noor Haddad, 李婷",
  version: 1,
  role: "member",
  participantIds: [me, li],
  channels: [
    {
      id: "dm",
      name: "DM",
      kind: "text",
      private: true,
      version: 1,
      topic: null,
      occupancy: null,
      position: 0,
    },
  ],
};

describe("conversation titles", () => {
  it("names a conversation after the other people once every name is known", () => {
    const names = new Map([[li, "李婷"]]);
    expect(conversationCounterparts(conversation, me)).toEqual([li]);
    expect(conversationTitle(conversation, me, names, "zh-Hant")).toBe("李婷");
    expect(titledResource(conversation, me, names, "en").name).toBe("李婷");
  });
  it("keeps the directory name while a name is missing and for servers", () => {
    expect(conversationTitle(conversation, me, new Map(), "en")).toBeNull();
    expect(titledResource(conversation, me, new Map(), "en")).toBe(
      conversation,
    );
    const server: ResourceSummary = {
      ...conversation,
      owner: { kind: "server", id: "s" },
      participantIds: undefined,
    };
    expect(
      conversationTitle(server, me, new Map([[li, "李婷"]]), "en"),
    ).toBeNull();
  });
  it("lists several people in the viewer's language", () => {
    const group = { ...conversation, participantIds: [me, li, mika] };
    const names = new Map([
      [li, "李婷"],
      [mika, "Mika"],
    ]);
    expect(conversationTitle(group, me, names, "en")).toBe("李婷 and Mika");
    expect(conversationTitle(group, me, names, "ja")).toBe("李婷、Mika");
  });
});
