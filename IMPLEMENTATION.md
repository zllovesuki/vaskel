# Developing vaskel.

This guide covers local setup and verification. To host an instance, follow
[INSTALL.md](INSTALL.md). The [documentation index](docs/README.md) links the
product and technical guides; [AGENTS.md](AGENTS.md) contains agent instructions.

## Local development

Use Node 24.14 or newer and the pnpm version pinned in
[package.json](package.json). Install the locked dependencies without lifecycle
scripts, prepare local configuration and apply the identity migrations:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run dev:setup
pnpm run db:migrate:local
pnpm run types
pnpm run dev
```

The setup helper creates ignored, mode-0600 `apps/server/.dev.vars` with fresh
local secrets and an expiring bootstrap key. It leaves an existing file intact
and does not print secrets. The [example](apps/server/.dev.vars.example)
describes the settings. Keep `AUTH_ORIGIN` aligned with the local URL; same-port
HTTP loopback aliases are accepted, while HTTPS origins must match exactly.
Email delivery is simulated locally.

The Cloudflare Vite plugin serves the browser and Worker together. Development
and local D1 migrations share `apps/server/.wrangler/state/`. They load local
configuration from `apps/server/.dev.vars`, with no root fallback.
Local migrations touch no cloud resources.

The development server does not register a service worker. Use a built preview
for offline-shell and update tests; see [browser acceptance](tests/e2e/README.md).
The separate landing page runs with `pnpm run dev:site` and builds with
`pnpm run build:site`.

## Development compatibility

There is no released client/schema compatibility baseline yet. Until `v0.1.0`,
producers, schemas and consumers evolve together. Required fields describe the
current behavior; development changes do not need fallback readers or staged
rollouts.

Before that release, local and staging data are disposable. Edit the relevant
baseline files and reset affected storage rather than maintaining migrations for
development data. This applies to browser storage too. Starting with `v0.1.0`,
follow the [data-preserving upgrade policy](docs/operations.md#upgrades-and-supported-tooling)
and preserve released migration files.
[Engineering](docs/engineering.md#schemas-and-migrations) explains the schema layout.

### Reset local data

Stop the development server, remove **only** `apps/server/.wrangler/state/`,
then run `pnpm run db:migrate:local`. This deletes local accounts, messages,
calls and files, and recreates D1 from the baseline. Actors initialize their
schemas on first use. Renew the bootstrap expiry for a new local host.

Keep `apps/server/.dev.vars` and proof archives outside the state directory.
Leave any root `.wrangler/state/` untouched. Editing, renaming or regrouping an
already-applied baseline requires this reset; applying migrations over old
storage does not reconstruct it.

Staging schema or actor-identity changes can also require fresh cloud resources
before a separately authorized deployment. A rollback across those changes
needs matching storage. Storage resets do not require regenerating credentials.

## Working on the code

Browser code lives in `apps/client`, Worker code in `apps/server`, and the
website in `apps/site`. Shared schemas and text grammar live in
`packages/contracts`; shared presentation code lives in `packages/ui`.
Applications use their explicit `@vaskel/contracts/*` and `@vaskel/ui/*` exports.
[Engineering](docs/engineering.md#workspace-boundaries) describes import boundaries.

Start with the affected source, tests and [topic guide](docs/README.md#topics).
[Product policies](docs/product-review.md) define intended behavior; resolve any
disagreement with the implementation explicitly. Keep authorization and mutations
in the owning transaction, preserve exact retry identity, and reject stale work.
Lifecycle changes need the relevant failure and cleanup tests.

Run checks for the affected behavior and fix regressions caused by the change.
Persistence changes need native Worker/DO proofs, wire changes need producer
validation, and interface changes need browser inspection. Media changes need
the appropriate local, provider or device evidence within the
[authorized scope](AGENTS.md#reference-use-and-evidence). Preserve the Kysely
adapter proofs when changing adapter versions or transaction behavior.

Use the [documentation policy](AGENTS.md#documentation-ownership) to decide
whether a guide needs to change. A code change alone does not require a prose
update. When prose changes, review meaning, Markdown and links; application
tests are needed only when the edit affects a tested behavior or a document
consumed by a test.
Once the required checks pass, broaden them only for changed code, a failure or
an unresolved concern within scope.

## Validation

The full instance check sequence is:

```sh
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm run test
pnpm run build
pnpm run test:build
pnpm run test:browser
```

Use `pnpm test --project client-unit`, optionally followed by a test path, for
focused client logic. Other projects are `server-unit`, `site-unit`, `ui-unit`
and `server-runtime` for workerd. `test:unit` selects the Node projects;
`test:runtime` selects workerd. Tests cover rollback, duplicate commands, stale
generations, replay gaps, permission changes and interrupted cleanup.

`test:build` and `test:browser` need a current build. Browser checks also need
[compatible Chromium](tests/e2e/README.md). Run `types` after installation or
binding changes.
[Engineering](docs/engineering.md#typescript-and-tooling) describes each check's
scope and the build outputs.

Release validation checks the D1 baseline against Better Auth's required schema.
This proof is included in `pnpm test`; an unchanged tagged release does not need
to repeat it during installation. After changing Better Auth or the identity
schema, rerun it before deployment:

```sh
pnpm run test:runtime apps/server/tests/auth-database.test.ts
```

Apply the validated migrations to the selected environment before deploying.
Local tests and builds do not authorize
deployment or live-provider work; follow [AGENTS.md](AGENTS.md#reference-use-and-evidence).
