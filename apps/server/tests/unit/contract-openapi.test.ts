import { describe, expect, it } from "vitest";
import { generateOpenAPI } from "@/server/http/openapi";

describe("exported HTTP contracts", () => {
  it("describes successful commands separately from semantic failures and their recovery payloads", async () => {
    const document = await generateOpenAPI();
    const send = document.paths?.["/resources/{kind}/{id}/send"]?.post;
    expect(send?.requestBody).toBeDefined();
    expect(JSON.stringify(send?.responses?.["409"])).toContain(
      "COMMAND_CONFLICT",
    );
    expect(JSON.stringify(send?.responses?.["200"])).not.toContain(
      "command_conflict",
    );
    expect(send?.responses?.["502"]).toBeUndefined();
    const replay = document.paths?.["/resources/{kind}/{id}/replay"]?.post;
    expect(JSON.stringify(replay?.responses?.["409"])).toContain(
      "RESET_REQUIRED",
    );
    expect(document.paths?.["/resources/{kind}/{id}/socket"]).toBeUndefined();
  });

  it("exports public instance and invitation reads alongside session-authenticated operations", async () => {
    const document = await generateOpenAPI();
    expect(document.servers).toEqual([{ url: "/api" }]);
    expect(document.paths?.["/instance"]?.get?.security ?? []).toEqual([]);
    expect(document.paths?.["/invites/inspect"]?.post?.security ?? []).toEqual(
      [],
    );
    expect(document.paths?.["/identity/profile"]?.post?.security).toEqual([
      { sessionCookie: [] },
      { secureSessionCookie: [] },
    ]);
    expect(document.paths?.["/media/publish"]?.post?.security).toEqual([
      { sessionCookie: [] },
      { secureSessionCookie: [] },
    ]);
    const after = document.paths?.["/directory"]?.get?.parameters?.find(
      (parameter) => "name" in parameter && parameter.name === "after",
    );
    expect(after).toMatchObject({ name: "after", in: "query" });
    expect(after).not.toHaveProperty("required", true);
  });
});
