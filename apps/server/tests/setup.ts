import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeEach } from "vitest";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.IDENTITY_DB, env.TEST_MIGRATIONS);
});

// Socket close events can precede server-side presence cleanup. Reset actors
// while Vitest's module-resolution channel is still available.
afterAll(reset);
