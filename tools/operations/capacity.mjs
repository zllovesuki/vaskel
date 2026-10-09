import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Bounded synthetic evidence using the official Cloudflare Vitest pool with the
// public fixture bindings of the test suite; no application persistence,
// credentials, cloud resources or existing dev server are used.
const root = fileURLToPath(new URL("../../", import.meta.url));
const serverRoot = join(root, "apps/server");
const serverManifest = new URL(
  "../../apps/server/package.json",
  import.meta.url,
);
const run = join(root, ".wrangler", "capacity-runs", randomUUID());
function packageManifest(name, parent = serverManifest) {
  const path = findPackageJSON(name, parent);
  assert(path, `Missing server dependency: ${name}`);
  return path;
}
const vitest = join(dirname(packageManifest("vitest")), "vitest.mjs");
await mkdir(run, { recursive: true, mode: 0o700 });
const environment = {
  PATH: process.env.PATH,
  CI: "1",
  NO_COLOR: "1",
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
};
const startedAt = new Date().toISOString();
const started = performance.now();
function execute(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Capacity fixture failed (${signal ?? code}).`)),
    );
  });
}
const pool = join(serverRoot, "tools/vitest-pool.ts");
const reports = [];
for (const budgetBytes of [8 * 1_024 ** 2, 64 * 1_024 ** 2]) {
  const directory = join(run, String(budgetBytes));
  await mkdir(directory, { mode: 0o700 });
  const reportFile = join(directory, "measurements.json");
  const reporter = join(directory, "reporter.mjs");
  await writeFile(
    reporter,
    `import { writeFileSync } from "node:fs";
export default class CapacityReporter {
  records = [];
  onTestCaseResult(test) {
    const meta = test.meta();
    if (meta.capacityBoundary) this.records.push({ boundary: meta.capacityBoundary });
    if (meta.capacityMeasurement) this.records.push({ workload: meta.capacityMeasurement });
  }
  onTestRunEnd() { writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(this.records), { mode: 0o600 }); }
}
`,
    { mode: 0o600 },
  );
  const config = join(directory, "vitest.config.mts");
  await writeFile(
    config,
    `import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { fixturePoolOptions } from ${JSON.stringify(pool)};
const budget = { OWNER_SQL_BUDGET_BYTES: ${JSON.stringify(String(budgetBytes))} };
export default defineConfig(async () => ({
  root: ${JSON.stringify(serverRoot)},
  cacheDir: ${JSON.stringify(join(directory, "cache"))},
  resolve: { alias: { "@/server": ${JSON.stringify(join(serverRoot, "src"))} } },
  plugins: [cloudflareTest({ ...(await fixturePoolOptions(budget)), remoteBindings: false })],
  test: {
    include: ["tests/operations-capacity.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    reporters: ["default", ${JSON.stringify(reporter)}],
  },
}));
`,
    { mode: 0o600 },
  );
  await execute([vitest, "run", "--config", config]);
  reports.push(...JSON.parse(await readFile(reportFile, "utf8")));
}
const boundary = reports.find((item) => item.boundary)?.boundary;
const workload = reports.find((item) => item.workload)?.workload;
assert(boundary && workload, "Both native capacity reports are required.");
const versions = {};
for (const name of [
  "workerd",
  "wrangler",
  "vitest",
  "@cloudflare/vitest-plugin",
  "kysely",
  "kysely-durable-objects",
]) {
  versions[name] = JSON.parse(
    await readFile(
      packageManifest(
        name,
        name === "workerd"
          ? pathToFileURL(packageManifest("wrangler"))
          : serverManifest,
      ),
      "utf8",
    ),
  ).version;
}
const report = {
  startedAt,
  elapsedMs: performance.now() - started,
  machine: {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    totalMemoryBytes: totalmem(),
    node: process.version,
  },
  versions,
  boundary,
  ...workload,
  limits: [
    "Local native workerd measurements, not production latency/placement/capacity guarantees.",
    "SQL used-page bytes exclude free pages, WAL, backups and archive copies.",
    "Growth admission can overshoot by one accepted command; continued safety/cleanup writes consume remaining headroom.",
    "D1 global identity admission and aggregate SQL/R2/media billing caps are not established.",
  ],
};
const output = join(run, "report.json");
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
console.log(`Capacity report: ${output}`);
