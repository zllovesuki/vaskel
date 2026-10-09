import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fixtureAuthVars } from "../../../../tests/config/bindings.ts";

describe("production configuration with deterministic fixture overrides", () => {
  it("uses every fixture value instead of local development vars or secrets", () => {
    for (const name of Object.keys(fixtureAuthVars) as Array<
      keyof typeof fixtureAuthVars
    >) {
      // A failed isolation assertion must never print an inherited secret value.
      expect(
        env[name] === fixtureAuthVars[name],
        `Fixture override: ${name}`,
      ).toBe(true);
    }
  });

  it("preserves production resources and adds the storage probe and test migrations", () => {
    expect(env.IDENTITY_DB).toBeDefined();
    expect(env.ATTACHMENTS).toBeDefined();
    expect(env.ASSETS).toBeDefined();
    expect(env.CF_VERSION_METADATA).toBeDefined();
    expect(env.EMAIL).toBeDefined();
    expect(env.SERVER_DO).toBeDefined();
    expect(env.CONVERSATION_DO).toBeDefined();
    expect(env.DATABASE_PROBE).toBeDefined();
    expect(env.TEST_MIGRATIONS).toBeDefined();
  });
});
