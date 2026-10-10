# Engineering contracts

The Worker validates external requests and dispatches typed RPC. Actors keep
authorization and mutations in native transactions. Kysely queries must preserve
those runtime boundaries.

## Modules and validation

Keep HTTP/actor entry points thin. Domain operations, authorization, SQL,
synchronization, providers and cleanup have distinct responsibilities. Shared
actor helpers still run in the same actor and native transaction; extraction
must not add cross-actor hops or move decisions to the Worker. Frontend
state/resource ownership follows [Frontend](frontend.md). Avoid universal
service objects, circular imports and trivial one-expression modules.

Shared digest and encoding functions live in
[auth/crypto](../apps/server/src/auth/crypto.ts). Callers retain their own
representations and key domains for identifiers, receipts, tickets, identity
tokens and search cursors. [Known-answer tests](../apps/server/tests/unit/crypto.test.ts)
protect stored forms when changing these functions.

Browser-safe schemas and text grammar live in [contracts](../packages/contracts/src);
trusted principal, internal captured data and secret-bearing types stay
server-only.

### Workspace boundaries

The private `@vaskel/client`, `@vaskel/server`, `@vaskel/site`, `@vaskel/contracts`
and `@vaskel/ui` workspaces use one root pnpm install. [Workspace configuration](../pnpm-workspace.yaml) disables
installation lifecycle scripts. Internal package dependencies use `workspace:*`.
Applications depend on contracts; contracts depend on no application.
Contracts expose explicit domain subpaths such as `@vaskel/contracts/messaging`
and `@vaskel/contracts/message-text` directly from maintained TypeScript source;
Vite, Wrangler and Vitest compile them without a package build or publication
step. Internal contract imports are relative. Its spoiler declaration bridge
must be reachable from exported consumers without including the whole package
in an application's TypeScript program.

Application TypeScript configurations map `@/client/*`, `@/server/*` or
`@/site/*` to their own source. Application source cannot import another
application's implementation or root tooling/test support. ESLint enforces
static/dynamic import boundaries and dependency ownership. Declare direct dependencies in every importing
workspace; package-manager visibility does not establish ownership. Contracts
own their schema/parser dependencies, applications own their runtime and local
test/build dependencies, and root owns
repository checks, orchestration and assembled acceptance tooling. Inside
`@vaskel/ui` a module imports only from its own folder or below, so
`components/` holds everything its components are built from, and a recipe
that one component draws lives in that component.

### HTTP contracts and validation

[Shared HTTP contracts](../packages/contracts/src/api.ts) define each JSON
operation's method, path, input, success output and semantic error codes. The
browser imports these executable contracts, never the Worker's implementation
or principal types. The [procedure router](../apps/server/src/http/contract-router.ts)
requires an implementation for every operation. Its domain handlers compose
[typed guards](../apps/server/src/http/procedures.ts) before calling the owner.
Resolving a directory owner does not authorize an action: the actor still checks
current identity, membership, generation, version, expiry and command receipts
in its transaction.

Hono bounds request bytes; the oRPC codec validates the request before procedure
guards resolve identity and owners. Malformed requests can therefore return
`BAD_REQUEST` before authentication or owner lookup. Valid requests for missing
or pending owners return `NOT_FOUND`; unavailable quoted originals return
`SOURCE_UNAVAILABLE` under the [captured-quote policy](messaging.md#captured-quotes).
Credential admission budgets run before reading bodies. Origin policy, account
preconditions, private no-store responses and redacted diagnostics apply across
both JSON and native transports. CSP and Permissions-Policy remain part of the
browser-facing response contract. Independently received representations,
including hibernation attachments and provider/socket input, retain their own
validation. Actor-owned data written through validated commands can be read under
that storage contract without repeating ingress validation; stored push
subscriptions, for example, do not repeat enrollment checks for each delivery.
Use typed named stubs for ordinary RPC, reserving actor `fetch()` for explicit
HTTP/socket needs. Named-actor selection belongs to the trusted caller; the
receiving actor does not rederive its own ID to verify that routing decision.
Typed internal RPC arguments and results do not need another wire-schema parse.

Actors retain tagged expected outcomes. After the actor's transaction completes,
the HTTP boundary translates refusals to the operation's declared oRPC errors,
retaining their recovery data. Configuration unavailability is a service failure,
not rejection of a session. Unexpected SQL/RPC/invariant errors must reject the
transaction before conversion to a sanitized error; catching inside the
transaction could commit partial state. Error correlation and redaction follow
[Operations](operations.md#observability).

The [browser adapter](../apps/client/src/api/contract.ts) validates responses.
[Frontend request lifetimes](frontend.md#request-and-account-lifetimes) define
response admission and recovery. Query keys and invalidation remain
[feature responsibilities](frontend.md#state-ownership); changing an input schema
alone does not implement filtering or distinguish cached results.

Attachment bytes, instance icons, search-rebuild progress and WebSocket upgrades
retain native Hono streaming/upgrade handling. Their shared
[transport declarations](../packages/contracts/src/api/transports.ts) describe
paths and scope. WebSocket ticket, lease, hibernation, replay and control-message
semantics remain in [Synchronization](synchronization.md); the HTTP codec does
not manage an established socket.

Export OpenAPI for tools and external clients to standard output from the same
JSON contracts:

```sh
pnpm --silent api:export
```

The export describes JSON operations and their cookie-authentication requirements.
JSON Schema cannot express every executable Zod refinement; server validation
remains authoritative. [Development compatibility](../IMPLEMENTATION.md#development-compatibility)
applies to wire changes.

## Native transactions

### Durable Object transactions

The [actor adapter](../apps/server/src/storage/actor-database.ts) constructs Kysely
from that object's exact `ctx.storage.sql`. Bounded awaited queries use native
asynchronous `ctx.storage.transaction()`: current authority,
message/FTS/event/receipt writes and durable wakeups share its rollback
boundary. External SFU, R2 and other-actor calls stay outside. Preserve normal
storage/output-gate durability for accepted commands.

Do not use Kysely's SQLite `db.transaction()` here: its SQL transaction-control
statements are unsupported. Do not add an outer `blockConcurrencyWhile` to the
native transaction. `transactionSync()` accepts synchronous SQL, not awaited
Kysely `.execute()`; the dialect's `withDoTransaction` wraps that synchronous
API and does not replace the asynchronous transaction.

The private declaration bridge in the adapter preserves the identical runtime
handle while accommodating the dialect's generic row constraint.
[Native database tests](../apps/server/tests/database-boundary.test.ts) establish
commit, rollback and isolation against workerd, including FTS and schema changes.
Preserve these proofs when adapter versions or transaction behavior change;
type compatibility alone cannot establish native transaction semantics. Adapter
fixtures use synthetic schemas, so application authorization and operator
recovery require their own checks.

`DurableObjectState.waitUntil()` is not the Worker's lifetime-extension
mechanism. Handle detached best-effort rejection, but put obligations that must
survive interruption in durable owner state with an alarm. Persist a recovery
wakeup before external work and condition completion on the current claim.
[Bounded work](../apps/server/src/actors/shared/bounded-work.ts) retains concurrency
slots until operations settle, even after the caller times out.

Alarm producers commit the obligation and its earliest wake in that same native
transaction; enqueue can only advance the alarm. Maintenance first performs
bounded local expiry transitions and claims, committing a successor before
external I/O. Fenced completions are followed in `finally` by a fresh, complete
deadline query and exact alarm replacement or deletion in one native transaction.
That refresh may retire an obsolete wake, but cannot use a pre-I/O snapshot to
cancel newer work. Active cleanup leases remain deadlines until completion or
expiry. Domain selectors distinguish validity expiry, pending-cleanup retries
and bounded retention continuation; retry delays never extend authority.
Unexpected storage/selector failures remain observable under the platform's
finite retry boundary, without a perpetual generic watchdog. A recovery write
that rolls back with a failed transaction cannot promise eventual progress.

[Workers clocks](https://developers.cloudflare.com/workers/runtime-apis/performance/)
advance after I/O, not during CPU work. Bound local loops by work count and use
timers for waits. Recheck expiry after external I/O before authorizing new work;
a timestamp captured before that I/O cannot establish current authority.

### D1 transactions

[The D1 adapter](../apps/server/src/storage/d1-database.ts) compiles known statements
for native `D1.batch()` and uses conditional SQL for compare-and-set. A batch is
not an interactive JavaScript transaction. The selected dialect's ordinary
prepared queries support bindings/sessions, with a private declaration bridge;
Kysely transaction methods are rejected.

[D1 boundary tests](../apps/server/tests/d1-boundary.test.ts) prove a later real constraint
violation rolls back earlier statements.
[Session tests](../apps/server/tests/d1-sessions.test.ts) cover primary authority and
directory consistency floors. Bookmarks do not prove current authorization;
[Access](access.md#identity-and-session-authority) owns identity/session
semantics.

## Schemas and migrations

Each SQL owner has an ordered migration history. Its initial baseline is split
by responsibility. Keep a table's indexes and seed rows beside its definition,
with one column per line. Small schemas with one responsibility can remain in
one file; file boundaries are for reading and ownership, not one file per table
or historical feature change.

[Identity D1](../apps/server/migrations/d1) groups identity, account lifecycle, directory and
instance administration. [Message owners](../apps/server/src/actors/shared/migrations)
group owner authority, messaging, invitations, attachments, direct messages and
realtime coordination. [Media rooms](../apps/server/src/actors/media/migrations)
separate participation from transport; [event dispatch](../apps/server/src/actors/event-dispatch)
keeps account-qualified admission/session fences and the last observed online
bit for transition detection, with no owner connectivity replicas. [Account media](../apps/server/src/actors/account-media/migrations)
has one intent/ownership table.

The [auth database proof](../apps/server/tests/auth-database.test.ts) runs Better Auth's live
schema validator against freshly applied native D1 migrations and verifies that
a missing required library column is rejected. [Development checks](../IMPLEMENTATION.md#validation)
define when to run it. Runtime auth disables schema introspection; the proof,
migration baseline and deployment migration step own compatibility checking.

D1 uses Wrangler's numbered migration files. Each actor explicitly lists its
SQL files in order; `migrateActorStorage` applies all pending files and their
ledger entries in one native transaction. Editing an applied file does not
rerun it. The validator rejects newer ledgers; recovery builds must retain
registrations for migrations already applied.
Released migration identities and SQL remain unchanged; append schema changes
under the [upgrade policy](operations.md#upgrades-and-supported-tooling).
[Development compatibility](../IMPLEMENTATION.md#development-compatibility)
covers disposable development state.

Wrangler actor namespace/class declarations are separate from SQL versions.
Changing those identities, including the
[event-dispatch partition count](#event-dispatch-sizing), needs a data-preserving
migration for released installations. Deployment or actor eviction does not reset
stored schemas. Fixture migrations test transaction failure boundaries and do not
establish a released upgrade policy.

Use indexed message rows, explicit FTS, receipts and bounded replay;
whole-object serialization is not the history model. Search analysis changes
must version ingest/query together and define rebuilds. Visible grapheme and
UTF-8 byte limits remain separate.

## Event-dispatch sizing

Four fixed account-ID partitions are the smallest compared topology that fits
the configured upper socket workload within the selected per-hub cap. A local
workerd comparison of one, four and eight partitions established no default-workload
advantage from eight. A separate four-partition sizing fixture exercised 4,096
accounts with eight sockets each and explicit refusal under skew. The prototype
omitted production identity/session work and lifecycle alarms, so it does not
establish deployed capacity, regional placement or billing. The
[executable limits](../apps/server/src/event-dispatch/limits.ts) own
partition, connection, ticket and batch bounds. Changing the partition count
changes where account sockets and fences live; disposable experiments need fresh
state, while released installations need a migration.

## TypeScript and tooling

Separate TypeScript programs isolate browser, ordinary Worker, service worker,
tooling and fixture globals. Lint parses TypeScript independently of the compiler
API. Client/Worker/service-worker/generated-binding programs retain strict library
checking; tooling/test exceptions are explicit in their configs. The server
declares `@cloudflare/workers-types` for the D1 dialect's imported module types;
generated Wrangler declarations still own application runtime globals. The
[Mediabunny adapter](../apps/server/tsconfig.demux.json) is checked separately
against its byte-only interface, isolating conflicting browser declarations
from Worker globals. Declarations alone do not type-check JavaScript bodies.

Each workspace owns its source/type/test configurations; root TypeScript
programs cover repository tooling and assembled tests. The root
[Vitest configuration](../vitest.config.ts) selects workspace projects and their
environments. Tests belong beside their workspace; combined build and browser
acceptance live at the root. Synthetic bindings remain test-only, and
built-artifact tests require a current build.

Test programs resolve `@tests/*` within their workspace. The reserved
`@tests/shared/*` prefix always names root `tests/helpers/`; shared helpers use
that prefix or relative sibling imports so their dependencies keep the same
meaning in every workspace.

| Check                                | Boundary                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| Typecheck, lint, formatting          | Static/runtime separation and source conventions                                      |
| Native workerd Vitest                | Real D1, DO SQLite, R2 and actor/HTTP/socket behavior with synthetic bindings         |
| Client/server Node unit suites       | Client logic and pure server failure boundaries                                       |
| Built-artifact harness               | Production assets, configuration and HTTP contracts                                  |
| [Playwright](../tests/e2e/README.md) | Built UI, real app producers and native browser storage; media fixtures remain scoped |

The client-owned [Vite configuration](../apps/client/vite.config.ts) explicitly
points the official Cloudflare plugin at the server's
[Wrangler configuration](../apps/server/wrangler.jsonc), serving assets and
Worker together without a development proxy. This configuration-level assembly
and scoped test fixtures may reference both implementations; application imports
still follow the source boundary. The combined build owns
`apps/client/dist/client/` and `apps/client/dist/vaskel/wrangler.json`.
Root commands coordinate the combined instance build and deployment.
The landing page has its own workspace, configuration and deployment in `apps/site`.

Brand files ship from one committed master. [Brand](../packages/ui/src/brand.ts)
defines the mark's geometry, reads its colours from the theme tokens and names
the files each surface carries; `pnpm run brand` regenerates
`packages/ui/brand/` (rasters through the browser-test Chromium, the share card
in IBM Plex Sans); and the shared [Vite plugin](../packages/ui/tools/brand-vite.ts)
serves that master in development and emits it into each browser build. Neither
application keeps copies. Instance icons have their own
[operator-managed lifecycle](operations.md#instance-administration).

Both browser builds use the [Plex font plugin](../packages/ui/tools/fonts-vite.ts),
which gives IBM's stylesheets `font-display: swap` and keeps emitted file names
URL-safe.

Native tests run the production Wrangler configuration with
the [fixture Worker and Miniflare overrides](../apps/server/tools/vitest-pool.ts); test-only
bindings are declared once beside the generated production declarations in the
[fixture augmentation](../apps/server/tests/fixtures/bindings.d.ts), and D1 migrations reach
test setup through the `TEST_MIGRATIONS` binding.
See [Development checks](../IMPLEMENTATION.md#validation) for commands. Generate production binding
types after installation or binding changes.

## Proposed tooling changes

TypeScript project references remain deferred. Any future build change must
preserve the separate browser, Worker, service-worker, tooling and fixture
programs and their runtime globals.

## Implementation references

Shared frontend conventions reference the
[limic frontend specification](https://limic.dev/frontend-spec.md).
[sources.json](sources.json) records reviewed revisions and the Kysely/workerd
and SFU source references. Private reference repositories are optional; they are
not needed to build, run or understand vaskel.

Libraries must solve a concrete correctness/maintenance problem with compatible
ownership, licensing and runtime support. See
[Readiness](readiness.md#deferred-engineering-proposals) for unadopted alternatives
and [Media](media.md#verification-and-references) for provider references.
