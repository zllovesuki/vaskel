// Test-only bindings beside the production declarations in worker-configuration.d.ts.
// Runtime values come from the root tests/config/bindings.ts through Miniflare overrides.
declare namespace Cloudflare {
  interface Env {
    DATABASE_PROBE: DurableObjectNamespace<
      import("@tests/fixtures/database-probe").DatabaseProbeDO
    >;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
