# vaskel. agent guidance

## Rules to remember

1. "Can we do more with less code?"
2. "Do the hard things now, or be forced to do harder things in the future."

Apply these rules in order to the agreed product requirements. Start with the
smallest implementation that preserves correctness, performance, security and
clarity. Prefer the smallest diff when the problem is truly local. If the smallest
diff creates known fragility, blurred ownership, or an architectural dead end,
pay the structural cost now.

For consequential architectural decisions, briefly state the intended user
experience, adopted requirements and accepted failure behavior.
Distinguish these from assumptions and optional precautions, and identify the
source of requirements that drive the design. Inspect existing decision owners,
recovery behavior and standard mechanisms before adding state or coordination.

For each substantial new guarantee, blocking prerequisite or coordination
responsibility, explain the concrete user consequence it prevents, why existing
behavior and recovery are insufficient, and the cost it introduces. Apply the
same standard when reviews propose additional safeguards. A conceivable failure
alone does not establish a requirement to prevent it.

For browser findings, an issue a human user cannot encounter through actual
browser use is not a bug. Before classifying a finding as a bug or scheduling a
fix, establish a concrete user scenario and reachable browser/runtime conditions,
supported by reproduction or platform evidence. A mocked or injected failure
proves only how code responds to that condition, not that the condition can occur
for a user. Keep findings with unestablished reachability as research, outside
the implementation queue. Failure to reproduce alone does not prove impossibility.

When complexity is challenged or revisions keep adding coordination and
exceptions, revisit those premises before refining or replacing mechanisms.
Compare alternatives at equivalent useful product scope. A proposed
simplification should explain the user benefit it preserves, the responsibility
it removes and any guarantee it changes. Moving a responsibility into another
module does not remove it.

Preserve authorization, durable command identity, stale-response rejection and
required cleanup guarantees. Do not silently strengthen or relax adopted product
requirements; surface consequential changes with a reasoned recommendation.

Consult the relevant case study when revisiting a design tradeoff:
[startup](docs/case-studies/startup-skeleton.md),
[guarantees and coordination](docs/case-studies/guarantees-and-coordination.md),
[client updates](docs/case-studies/client-update-assumptions.md) or
[notification scope](docs/case-studies/web-push-product-boundary.md).

## Task context

Start local implementation edits with the affected source and tests. Consult the
[guide for the affected area](docs/README.md#topics)
when changing behavior, layout, ownership, lifetimes or guarantees, or resolving
uncertainty about them. Sections labeled **Proposed** and discovery notes are not
requirements. Do not read the whole documentation set for an ordinary task.

Use [IMPLEMENTATION.md](IMPLEMENTATION.md) for schema rules, relevant checks,
regression handling and stopping conditions. Resolve routine implementation
choices within established constraints. Ask when an unresolved product decision
materially changes the result, and report remaining blockers precisely.
Readiness is not an automatic task queue.

When prior work would resolve a relevant uncertainty, start with
`.local/notes/README.md` if present, select the relevant topic, then discover
Markdown filenames within it and read only the relevant notes. Consult archived
material for a specific historical question. Historical scripts, manifests and
reports record earlier work; their existence does not establish a workflow to
repeat. These optional notes may be absent or stale; current code and tracked
guides remain authoritative. Do not bulk-read `.local/` or open credentials,
browser profiles or runtime databases merely to gather context.

## Core constraints

Use TypeScript 7, React 19, Tailwind CSS v4, TanStack Router/Query/Virtual,
Floating UI, Hono, oRPC/Zod and Kysely. Additional maintained libraries are allowed
where they improve architecture or maintainability.

One instance serves one operator and several circles with shared accounts and
DMs. D1 holds identity/directory data, not canonical messages or a
global message-search mirror. ServerDO and ConversationDO own message SQL,
permissions and local FTS. MediaRoomDO coordinates audio, camera and screen
sharing through raw Realtime SFU. Attachments remain private in R2. The
[state ownership map](docs/architecture.md#state-ownership) defines the complete
inventory.

The Worker validates external input and dispatches typed actor RPC. JSON HTTP
operations use the shared oRPC/Zod contract; native streams and WebSocket
upgrades stay in Hono. Actor expected failures remain tagged outcomes; HTTP
contracts declare typed errors.
Authoritative checks and mutations share the owning actor's native transaction;
D1 uses native batches. Preserve the existing workerd proofs for Kysely adapters,
rerunning or extending them when adapter or transaction behavior changes. Use one
executable wire contract and keep sequence high-water independent of retained
events.

Frontend and backend must be modular. Keep entry points thin and split domain
operations, authorization, SQL access, synchronization, provider clients, media
negotiation and cleanup by responsibility. Refactoring into modules must not
move a transaction across actors or add unnecessary runtime hops.

The private pnpm workspaces are `apps/client`, `apps/server`, `apps/site`,
`packages/contracts` and `packages/ui`. Application dependencies flow from the
applications to the shared packages' explicit source exports; application source
must not import another's implementation or root test/tooling support. Declare
direct dependencies in each importing workspace. Client-owned Vite assembles the
browser and server Worker together; root commands coordinate one instance
build/deployment, and separately the landing page's build/deployment.

## Working agreements

Prefer concise paragraphs in responses; avoid unordered lists unless preserving
existing formatting or producing an artifact that requires them.

Use concise Conventional Commit subjects. Explain what changed, why, and how
when the mechanism matters. Keep the body proportional to the change; omit it
when the subject suffices. Cut repetition, file inventories, task narration and
generic assurances. Routine check commands, pass counts and verification
sections belong in the task response or PR, not the commit.

## Git workflow

Preserve unrelated changes in this and reference repositories.

Use Git worktrees under `.worktrees/<task>/` for new code and documentation work
by default; reuse them for follow-ups. Edit the primary checkout only when
explicitly requested.

Within the task's worktree, agents may do the required work, including editing,
testing and local commits. Integrate verified work through Git only when
requested. Push only when separately requested. Passing checks or agreement on
a workflow authorizes neither integration nor pushing.

Follow [local setup](IMPLEMENTATION.md#local-development) for configuration and
runtime paths. Give each preview its own port, synthetic configuration and
runtime data. Do not copy credentials or runtime state during integration; leave
existing root `.wrangler/state/` untouched. Reserve `.wrangler/` directories for
runtime state, generated artifacts and existing proof archives. Exclude nested
checkouts from the parent's lint, formatting and development watcher without
excluding a worktree's own source.

For maintainers, `dev` in private `zllovesuki/vaskel-dev` is the source of truth
with full history. Base task worktrees on `dev` and target it for requested
integration. Public `release` in `zllovesuki/vaskel` is updated only for requested
publication.

Cherry-pick new `dev` commits since the previous publication's source tag onto
`release` in order; their hashes will differ. Record publication source revisions
with private Git tags and put public release tags on public commits. Resolve
public contributions in `dev` first and compare the resulting trees before
publishing.

Never merge private development history into public `release`. Verify the
destination repository and push explicit public branch/tag refs; do not use
`--all`, `--mirror` or `--tags` with the public repository. Keep this guidance
shared between both repositories. Public contributors and operator installations
can work from their public baseline without access to the private repository;
follow [INSTALL.md](INSTALL.md) for operator-owned repositories.

## Reference use and evidence

Consult the pinned Realtime example or application repositories in
[docs/sources.json](docs/sources.json) when behavior depends on their
implementation or current vaskel guidance leaves a question unresolved. Read
applicable instructions before inspecting a reference checkout. vaskel's current
contracts remain authoritative; examples do not authorize importing their
product assumptions. Never read or copy credentials merely to inspect an
example project.

Design documents alone do not authorize application implementation, deployment
or live SFU validation. Carry out deployment or live-provider work only when
authorized by the request or existing session context. Keep local and live
evidence distinct and report only what ran. Deployments use the operator's own
SFU, mail and other resources; never infer permission to use a maintainer account.

## Documentation ownership

Tracked docs explain supported behavior, consequential guarantees and limits,
operating procedures, and rationale needed to maintain them. They are selective:
a feature, fix or behavior change does not automatically require a prose change.
Update docs when a change makes a retained explanation materially inaccurate,
changes an adopted policy or operating procedure, or introduces a capability or
constraint that readers need explained. A task can finish without a docs diff
or a separate justification for leaving docs unchanged.

Add understanding that the relevant code does not adequately provide. Explain
intent, consequences and relationships readers would otherwise have to infer;
do not paraphrase implementation steps or enumerate tested cases. Overviews and
procedures can assemble facts from code when that serves the reader's task.
If an existing passage merely repeats implementation detail, remove or narrow
it instead of maintaining a second description. Preserve adopted guarantees;
an observed implementation detail does not by itself establish a product policy.

Preserve detail required by an existing tool workflow, even when it mirrors
code. Impeccable's [DESIGN.md](apps/site/DESIGN.md), for example, carries
machine-readable tokens and canonical sections consumed by design tools. Those
artifacts follow their owning workflow's format and maintenance rules rather
than ordinary prose deduplication.

Write for the reader's task: README introduces the product, INSTALL covers
agent-led hosting, IMPLEMENTATION covers development, and docs/README indexes
topics. Agent instructions belong here. Keep entry pages short; split guides for
independent reader questions. This policy also applies to READMEs beside source
and tests.

Give each documented policy or decision one authoritative home. Product policies
own intended behavior; guides explain enforcement and rationale; executable
schemas and configuration own shapes and limits; tests own repeatable checks
and fixtures.
Resolve policy/implementation disagreements explicitly. Link rather than repeat,
unless a local consequence or warning is needed. Keep exact implementation
details at their source and local rationale beside the code. Leave correct
explanations alone. Do not append completion notes, refactor recaps or test
results; keep history only to explain a current decision or a supported upgrade.

Use neutral policy language and concrete actors and actions. Retain technical
terms that express actual guarantees; do not attribute requirements to
conversation participants. Preserve proposal labels and meaningful evidence
limits, and date pricing assumptions.

Create task artifacts only when requested or required by the current workflow.
Keep plans, reports, measurements, raw logs and screenshots in ignored
`.local/notes/` or runtime/proof storage with revision, environment and
reproduction details. Before archiving, ensure adopted decisions and material
evidence limits that meet this policy remain in the owning guide or Readiness.
Tracked docs and tests must not depend on local archives.

When documentation changes, review its diff separately from code before handoff.
Preserve rationale, failure guarantees and evidence limits; remove
inventories and checklists already owned by source/tests. Check meaning, Markdown
and relative links/anchors, repairing incoming links and source-catalog entries
when moving sections. Coordinators own this review after delegated integration.
