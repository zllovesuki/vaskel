# Deployment and operations

Each operator supplies their own Cloudflare identity/storage, email domain and
SFU application.

For a new installation, follow [INSTALL.md](../INSTALL.md). Local setup and
storage resets are in the [development guide](../IMPLEMENTATION.md#local-development).
This guide covers configuration, administration and recovery for an existing instance.

## Deployment environments

[wrangler.jsonc](../apps/server/wrangler.jsonc) contains local defaults and explicit
staging/production bindings. Configure the selected environment for the
operator's account before deploying; repository hostnames/resource IDs are not
portable defaults.

| Setting                                               | Supply for each environment                                       |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Account, Worker name, Custom Domain and `AUTH_ORIGIN` | Own account, distinct Worker and exact HTTPS application origin   |
| `IDENTITY_DB`, `ATTACHMENTS`, actor bindings          | Own D1 database, private R2 bucket and declared actor namespaces  |
| `PUSH_QUEUE` producer and consumer                    | Own Queue matching the selected environment's queue name          |
| `MAIL_FROM`, `EMAIL`                                  | Onboarded sending domain and compatible sender restriction        |
| `REALTIME_APP_ID`, `REALTIME_APP_SECRET`              | Operator-owned SFU app; secret in Worker secrets                  |
| `AUTH_SECRET`, `OPERATOR_BOOTSTRAP_SECRET`            | Independent random Worker secrets                                 |
| `OPERATOR_BOOTSTRAP_EXPIRES_AT`                       | Short future ISO expiry for first-host setup                      |
| Rate-limit namespaces                                 | Distinct account-scoped IDs                                       |

Keep environments' storage/secrets separate. One application Worker serves
Static Assets and all circles; creating a circle needs no infrastructure
deployment. The landing page (`apps/site`, vaskel.com) is a separate
assets-only Worker and hostname, deployed with `pnpm run deploy:site`. Runtime needs no
broad deployment API token. Local `send_email.remote: false` simulation does not
disable deployed delivery.

### Browser push resources

Provision the selected environment's `PUSH_QUEUE` from
[Wrangler configuration](../apps/server/wrangler.jsonc); the application Worker
is both producer and consumer. NotificationDO generates account VAPID keys.
Optional `PUSH_VAPID_SUBJECT` is a public HTTPS contact URL or `mailto:` address;
a blank value uses `AUTH_ORIGIN`.

Notification storage is added without resetting existing identity or message
data.

Enrollment needs the built application's service worker, which the source/HMR
server does not register. Use a built preview for local checks.

### Deployment commands

`pnpm run deploy:staging` and `pnpm run deploy:production` build the selected
environment and deploy the generated `apps/client/dist/vaskel/wrangler.json`.
Browser assets and the Worker ship together. For staging, apply identity
migrations with `pnpm run db:migrate:staging` after configuring its database ID.
[INSTALL.md](../INSTALL.md#configure-and-deploy) contains the production commands.
[Release validation](../IMPLEMENTATION.md#validation) owns the auth-schema proof;
repeat it when customizing authentication or the identity schema.

To identify the deployed server revision, read `tag` from `/api/health`; the
host also sees it as Version under Maintenance in Your vaskel. The
deployment commands set the tag to the short HEAD commit hash and include the
commit subject in the Worker version message. Uncommitted changes included in
the build are not represented by the hash.

Existing remote secrets persist on redeployment; retain them when resuming an
installation.

## Instance administration

Host settings manage the name/icon and new-invite policy. Public branding
reveals only name/icon; owner/member roles do not grant instance administration.
[Access](access.md#invitation-policy) defines instance-versus-circle invitation
authority and its bounded assertion lifetime. Policy hints refresh projections
after commit and may be missed; safety reads repair them.

Account inventory omits email, sessions and tokens. Usage inventory exposes
aggregate owner SQL/attachment accounting, no names, participants or message
content. Both use primary-D1 keyset pages, private no-store responses and
explicit partial coverage. Usage advances over inspected references including
failures, so retrying a page can recover omitted owners. More pages mean paging;
partial without continuation means unavailable coverage. It excludes pre-DM
block-pair storage, media/account actors and unreferenced namespaces, and is not
an atomic instance or billing snapshot. The UI shows loaded account count, not
an invented quota meter.

Instance icons accept only bounded PNG/JPEG/WebP with matching signature/type,
never SVG. Write a fresh private R2 key and publish only after fresh
operator/session/epoch authority in D1 within the publication deadline.
Failed/superseded bytes remain private. A bounded scheduled sweep uses a durable
cursor and removes expired unpublished keys; failed deletion cannot advance it,
and later sweeps catch late PUTs. Publication expires before cleanup
eligibility, preventing a collected key from becoming current. Signature checks
do not prove successful decoding.
[Icon lifecycle](../apps/server/src/instance/icons.ts) and
[host API](../apps/server/src/instance/administration.ts) own details.

## Instance admission

| Variable                      | Default | Counts                                                      |
| ----------------------------- | ------: | ----------------------------------------------------------- |
| `INSTANCE_ACCOUNT_LIMIT`      |     256 | All accounts, including host and unverified rows            |
| `INSTANCE_SERVER_LIMIT`       |      32 | All server directory rows, including pending creation       |
| `INSTANCE_CONVERSATION_LIMIT` |     512 | All conversation directory rows, including pending creation |

[Limit parsing](../apps/server/src/domain/instance-limits.ts) owns accepted ranges
and rejects malformed/out-of-range values. These are engineering admission
defaults, not measured workloads. Counts come from source tables, with no
separate counter. Abandoned unverified accounts and pending creation receipts
keep consuming slots; no automatic expiry/purge exists. Deleting a pending row
without reconciling its actor would break receipt recovery and accounting.

New admission checks live identity/session, applicable permission and count in
the same conditional primary write. Registration/bootstrap also commit
credentials, receipt, verification token and encrypted mail in the native D1
batch. A later constraint failure rolls everything back and concurrent
contenders cannot both consume the last slot. Invitation authorization is
separately server-owned; refused D1 admission may leave its existing expiring
invitation reservation, never a partial account/mail allocation.

Recover matching accepted receipts before new-allocation refusal. Registration
recovery precedes a fresh invitation check but grants no circle membership;
joining still checks current invitation authority. Changed fingerprints
conflict. Capacity refusal creates no new receipt and exposes no counts/private
policy. Bootstrap secret/expiry/completion/email-conflict and ordinary
authorization outcomes retain their precedence.

Lowering limits stops new growth without deleting retained allocations or
preventing exact retry. A mixed-version rollout can still admit under an older
larger limit until that Worker version retires; configuration is not an atomic
global policy update. Limits do not count every actor namespace or cap a bill.
See [directory admission](../apps/server/src/directory/admission.ts).

## Capacity boundaries

`OWNER_SQL_BUDGET_BYTES` defaults to 512 MiB with a 70% warning and 85%
new-growth pause. [Capacity contracts](../packages/contracts/src/capacity.ts) own ranges.
Native used-page accounting includes indexes/FTS/metadata and excludes free
pages, WAL and backups. Admission checks inside the owner transaction after
accepted-receipt recovery; one bounded command can cross the threshold. Reads
and safety/cleanup writes remain available and consume remaining reserve. This
is not a worst-case overshoot or physical-file-shrink guarantee.

When native SQL accounting reports pressure, growth commands reclaim a bounded
batch of expired owner receipts after authorization, command-time and exact
receipt checks, then remeasure used pages before admission. This also applies to
Send preflight, invitation paths, room creation and upload reservation. A refusal
can commit that cleanup while creating no new resource, receipt or sequence and
leaving attachment charges unchanged. Aggregate capacity inspection remains
read-only; reclamation does not require an admitted growth command.

The server is the storage/execution partition, so busy channels share pressure.
Attachment liability, upload concurrency, socket admission, media participants
and retained transports have separate executable bounds in
[attachments](../packages/contracts/src/attachments.ts),
[messaging](../packages/contracts/src/messaging.ts) and
[media](../packages/contracts/src/media.ts). No automatic expiry means capacity-limited
retention: warn/refuse new growth instead of silently deleting history. Operator
diagnostics do not grant private content access.

Account-event admission has separate per-account and per-hub socket/ticket
bounds in [dispatch limits](../apps/server/src/event-dispatch/limits.ts). Account IDs
map to fixed partitions; a full partition returns capacity rather than moving
an account's sockets and fences elsewhere. Skew can therefore refuse new
connections before the instance account ceiling is reached. The
[dispatch sizing rationale](engineering.md#event-dispatch-sizing) establishes local
prototype bounds and exclusions, not a supported deployed workload.

Use `node tools/operations/capacity.mjs` for bounded isolated local
measurements and retain reports in ignored local storage. The synthetic workload
does not establish event-dispatch/presence cost, production placement or a
supported deployment size.
[Costs](costs.md) owns dated pricing and workload calculations. Recheck provider limits before changing
runtime assumptions; [sources.json](sources.json) links official limits.
Platform ceilings and billing telemetry are not a demonstrated workload or
instantaneous dollar cap. A nearby Worker also does not establish nearby actors
or whole-application data residency.

## Observability

[Structured telemetry](../apps/server/src/telemetry.ts) explicitly projects typed
fields and fixed error classes. Never log raw exception details, bodies, search
text, mail envelopes, credentials, SDP or provider capabilities. A failed log
sink must not change command results/cleanup. Correlate client error references
with `X-Request-ID` and matched route; opaque owner/actor IDs identify scope
without private content.

Migration failures are logged in the actor because startup can fail before RPC
or alarm handlers run. The runner logs once per failed attempt after any native
transaction unwinds, then rethrows the original exception. HTTP and platform
error records may also appear.

Media diagnostics distinguish provider HTTP status from per-track failures,
including failures inside HTTP 200, and record negotiation causes before cleanup
waits. Correlate the route outcome and committed closure cause with the provider
event. Active-session HTTP 410 remains visible; absence is quiet only where the
caller accepts it as successful cleanup.

Owner lookups, broadcasts/reads, directory/policy work, account-event fanout and
unexpected provider failures produce bounded diagnostics. Mail/media summaries
describe one pass, including retries, timeouts and pending work; they are neither a
global backlog nor exactly-once delivery counts. Recovery after external failure
depends on a committed successor wake. Failed local transactions may leave no
successor; finite platform retries do not guarantee indefinite progress after a
failed durable write. [Alarm semantics](engineering.md#durable-object-transactions)
define that boundary. No successful message/body logging is added.

To investigate a reported failure, use its safe reference to locate the
route/owner event, then inspect the responsible bounded cleanup/admission
boundary. `/api/health` proves Worker liveness, not dependency readiness. Do not
invent fresh access on identity-store outage; existing connections follow their
leases. Preserve durable intent and backpressure under side-effect failure.

Local tests establish telemetry redaction and safe references; deployed
ingestion/lookup remains acceptance. Missing measurements include recipient
delivery versus acceptance, replay gaps/duplicates, oldest pending outbox age,
storage trends/hot owners, revocation completion and media join quality,
loss/jitter/bitrate. Analytics Engine/tracing remain proposed pending concrete
operator queries.

## Retention and incident handling

Owner alarms reclaim message-command and directed-block receipts after seven
days, and registration authorizations after thirty-five days, without later
request traffic. Physical cleanup may run after eligibility; it never extends
command, invitation, socket or media validity. Canonical messages and compact
security fences remain. Settled owners with only inert fences or attachment
holds do not keep waking for cleanup. See
[maintenance scheduling](synchronization.md#owner-maintenance-lifetime) and
[owner retention](../apps/server/src/actors/shared/retention.ts) for the bounded
reclamation policy.

[Message deletion](messaging.md#deletion-and-derived-text) and
[attachment retirement](attachments.md#retirement-and-late-writes) describe
seven-day payload retention, holds, late writes and charge release. Restricted
quarantine/incident preservation must not become ordinary moderator
DM/deleted-body access. Optional CSAM Scanning has no established
verdict/enforcement coverage on this private path; never expose R2 or bypass
authorization to enable it. Keep a monitored operator incident process and its
evidence separate from ordinary previews.

Completed mail diagnostics retain seven days from delivery/cancellation;
ciphertext clears immediately. Bounded native D1 cleanup protects active leases
and tokens referenced by envelopes, cancels expired/superseded unsent mail even
without configured delivery, and prunes only settled bookkeeping. The
five-minute cron supplies progress without traffic; eligibility is not an exact
deletion deadline. Audit, registration receipts and identity authority remain.
Registration retry can recover the account after delivery diagnostics expire
without recreating it. [Mail retention](../apps/server/src/auth/mail-retention.ts)
owns the statements.
[Media retention](media-transport.md#settled-retention-and-wakeups) uses a
separate policy.

## Upgrades and supported tooling

Forward upgrades preserve the data required by the product policies. Disposable
development state follows the
[reset procedure](../IMPLEMENTATION.md#reset-local-data). Keep released migration
files unchanged and add migrations for later schema changes, including browser
storage changes that require them. Storage resets are not an upgrade procedure.
Each release identifies supported source versions in its
[release notes](https://github.com/zllovesuki/vaskel/releases).

Apply pending identity migrations before [deploying the Worker and browser assets](#deployment-commands).
Actors apply their pending [schema migrations](engineering.md#schemas-and-migrations)
at startup. Open browser tabs may need
[Reload to update](client-storage.md#offline-application-shell) after deployment;
compatibility with older browser builds is not guaranteed.

Resume interrupted upgrades from the recorded migrations after fixing the
failing step. The retrying build must understand both the stored schema and its
migration ledger; an older build can reject already migrated actors.

Downgrades have no compatibility guarantee: deploying older Worker code leaves
migrated storage in place.

### Rebuild search indexes

The Search indexes row under Maintenance in Your vaskel. rebuilds message search
for ready circles and direct conversations. One operator-authenticated
`POST /api/operator/search-index/rebuild` request pages through the directory and
awaits each [owner rebuild](messaging.md#deletion-and-derived-text) sequentially.
The Worker refreshes the same account/session's operator authority between
owners and streams aggregate progress. A failed owner does not undo completed
owners; the final summary reports both confirmed and unconfirmed results.

The run lasts with its HTTP connection. Leaving the page stops further dispatch
when cancellation is observed, while an in-flight rebuild may finish. The client
requires an explicit completion event; connection loss is interrupted work,
not success. Repeating the whole action is safe and may rebuild already completed
owners. Enumeration follows directory pages, not an atomic instance snapshot.
Individual rebuilds occupy their owner until the native transaction settles;
platform execution limits still apply. No persistent job or automatic retry runs
after disconnect. Stream failures use sanitized events and private no-store
responses, including after HTTP headers have been sent.

Export, backup import/restore, archive transport, broader maintenance tools and
target cutover are deferred; there is no supported restore CLI or instance
restoration barrier. A future restore must handle erased receipts and stale
clients that could replay previously accepted commands. Per-resource platform
recovery is not coordinated vaskel. restore. Future account/circle deletion must
own durable progress across content, files, indexes and notifications; directory
deletion alone is insufficient. Any future history migration needs bounded copy,
catch-up, validation and one writable owner before old data removal.
