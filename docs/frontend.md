# Frontend architecture

The client preserves conversations, drafts and calls across navigation. Private
work requires current account and access authorization. React renders controller
state; the owners below manage navigation, server data and browser storage.

## State ownership

| State                                               | Owner                                                    |
| --------------------------------------------------- | -------------------------------------------------------- |
| Selected destination and shareable search           | Router/URL                                               |
| Accepted snapshots, queries and mutations           | Account/resource-scoped TanStack Query                   |
| Replay cursor and observed/read positions           | One active-owner synchronization lifetime                |
| Account request admission and identity freshness    | Document access coordinator                              |
| Scoped online samples                               | One document presence Query owner                        |
| New-message text/files/exact Send                   | Account-scoped draft manager and per-draft controller    |
| Inline edit/delete/remove attempts                  | Conversation message-work store                          |
| Peers, capture, media operation queues and playback | Account media controller                                 |
| Bounded recent offline history                      | Storage adapter with account and owner retirement checks |
| Open menus and local selection                      | Feature state                                            |

Query is the single online message cache. It does not establish replay order or
authorize disk hydration. Account-event hints reach mounted timelines and active calls
through the account-events provider's listener registries, never as Query invalidations.
Controllers own resources and cancellation; do not add a second canonical
timeline or recreate peers on ordinary renders. Dexie keeps browser history and
authored drafts in separate stores.

The entry points stay thin:
[workspace](../apps/client/src/features/workspace/workspace.tsx),
[access coordinator](../apps/client/src/features/cache/access/coordinator.ts),
[draft manager](../apps/client/src/features/drafts/manager.ts),
[media provider](../apps/client/src/features/media/provider.tsx). Extract by
responsibility and lifetime, preserving the existing decision owner.

## Startup and reconnect

Fresh identity admits account requests. Query loads sidebar discovery and the
selected destination independently. Known URLs read authorized owner metadata;
Home uses directory discovery to choose a default. Global pages require no owner.
Omission from the [directory index](access.md#directory-and-people) cannot reject
a named destination.

Router keeps the workspace layout mounted across destination loading, redirects
and local failures. Each route owns its data requirements; the sidebar observes
the active owner's metadata Query without becoming a second authority. This
supports [independent section loading](frontend-design.md#home-and-navigation) without
coordinating a shared readiness state. Account-owned draft and media controllers
remain above route leaves, including signed-in entry screens. Malformed search
values in a shared or hand-edited link are dropped so the destination still
opens. The route error screen is reserved for genuine failures, such as a route
chunk that no longer loads; it offers reload and Home, in the browser language
when the failure precedes the language provider.

Disconnection preserves the mounted conversation, draft/files and call controls.
Reconnect requires fresh identity and an authorized timeline snapshot before
conversation actions become available. A failed refresh retains accepted content
and offers local Retry; retirement checks can withhold the transcript while
preserving the draft. Denial retires the affected work. Cold cached history is a
separate passive view; [storage](client-storage.md#read-only-history) defines its
limits. The [startup case study](case-studies/startup-skeleton.md) records the
earlier simultaneous-reveal design.

## Request and account lifetimes

Private keys include instance, account and resource. Account-scoped API requests
capture `X-Vaskel-Expected-Account`; the Worker authenticates the cookie and refuses
mismatches. The header cannot choose an identity. This stops an old tab acting
as a replacement account after another tab changes shared cookies. Cancel
requests and dispose sockets/media on account retirement; cancellation alone is
insufficient, so decoded responses still check account, owner, generation and
request lifetime.

Cleanup retains its original account. Correlated sign-out revokes that session
without late cookie-clearing headers that could erase a newer sign-in. D1
bookmarks are memory-only/account-and-origin scoped. Account replacement or
terminal authentication rejection retires private Query/history, drafts/uploads
and media intent.

Browser subscriptions have a separate [account-bound enrollment lifecycle](notifications.md#enrollment-and-account-lifetime).
Retiring a login must not silently adopt its subscription for the next account.

The [HTTP contracts](engineering.md#http-contracts-and-validation) provide
success results and typed errors. Preserve recovery payloads for replay resets,
media recovery/restrictions, missing messages, blocking and unavailable originals.
A shared fallback retains HTTP denial facts when a response is unreadable.

Request scope comes from the operation declaration. Owner-scoped 403/404 retires
that owner's data; a missing individual message remains local. Administrative
and media 403/404 describe the requested capability or call, including when the
body is unreadable. On private operations and session checks, a 401 ends the
session, except that a validated wrong current password on account self-service
remains an inline form failure. Public entry operations and explicit cleanup
have their own admission/lifetime scopes.
[Request policy](../apps/client/src/features/cache/access/request-policy.ts)
implements these consequences without matching URLs.

HTTP and socket denials converge on the access coordinator, which purges the
denied owner's private state and refreshes discovery. The affected timeline
also retires its socket. Keeping retirement with one owner prevents independent
surfaces from disagreeing about access loss.

The access coordinator owns
[identity freshness and profile deadlines](access.md#client-identity-freshness).
Relevant account mutations force a session check. Profile refresh merges
preference revisions in place and preserves account replacement fences.

An individual request's network failure stays with that operation; it does not
disconnect unrelated queries or media sessions. Browser offline signals and
identity-check failures retain account-wide handling. Async account work checks
its captured coordinator lifetime before creating another resource. This fence
changes on retirement or a new reconnect attempt; an in-place same-account
identity refresh and unrelated owner changes do not invalidate it.

Safe request references may appear in generic localized errors; raw server error
text must not. [Operations](operations.md#observability) defines
correlation/redaction. Revoking other devices must preserve this session/socket;
revoking this device uses ordinary logout.

## Rendering and interaction lifetimes

Use route metadata to select page kind. Shared primitives handle focus,
dismissal and keyboard input while callers make domain decisions. One modal
dialog primitive handles Escape, close-control and outside-click dismissal and
returns focus to its
opener; a caller with pending work treats dismissal as Keep. One command menu
primitive owns arrow-key and typeahead navigation, including participant
moderation. Creation flows, including invitations from the conversation header,
use modal dialogs; menus/search use popovers. Unavailable data and failed
commands present through the shared `Unavailable` and `Failure` components, so
Try again and its network gating live once.

TanStack Form owns ordinary form values/validation/reset, Query owns mutation
status, and retryable commands
retain identity until submitted values change. Composer drafts remain a distinct
domain.

Each People or circle-settings page keeps administration controls busy until
the current command and its refreshes settle. Invitation creation refreshes the
invitation list when its request settles, even after the dialog closes.

Keep the composer mounted through updates and IME composition. Virtualize long
message/member lists with measured sizes and stable anchors.
[Synchronization](synchronization.md#bounded-resident-timeline) owns following,
historical intent and read advancement.
[Client storage](client-storage.md#authored-drafts) owns saved work;
[Attachments](attachments.md#inline-previews-and-the-media-viewer) owns
previews, grants and the viewer. Frequent presence/media updates should use
focused subscriptions rather than rerender the whole application.

Message parsing uses the shared CommonMark/GFM/spoiler grammar. Raw HTML remains
inert; Markdown images never fetch remote resources. Private attachments render
through their granted URLs. External links use `noopener noreferrer`. Hidden
spoilers stay out of focus and accessibility until revealed; a link with a
spoiler in its label displays without navigation, while links inside a revealed
spoiler work. GFM tables keep standard pipe grammar.

Mentions encode stable IDs through parsed empty links under `/mentions/`; code,
including an unclosed fence, stays literal. Composer/editor display names are a
projection over that identity. Selecting among duplicate names retains the
chosen ID; typing a name alone grants none, and edits through a selected range
remove its mapping. Parser source positions align with textarea selections and
canonical serialization prevents hostile labels creating markup or recipients.
Sending can normalize Markdown spelling.
[Shared grammar](../packages/contracts/src/message-text.ts) and
[mention field](../apps/client/src/features/chat/mention-field.tsx) own the mechanics.

## Persistent media presentation

The account provider owns one controller and one audio playback owner across
routes. A visible registered stage determines whether dock/phone controls yield;
a matching URL alone does not. Joining/failure controls stay reachable on the
call page, mobile Home and a folded DM stage. Stage cameras and a selected
screen have independent reception choices: picture-in-picture can retain
screen/audio when the stage is hidden; hiding both withdraws that screen without
creating another transport.

Components issue actions and subscribe to state. Explicit move-session and
transferred-away shutdown follow [Media](media.md), while queued peer
negotiation and obsolete-track rejection follow
[Media transport](media-transport.md). Language changes preserve mounted
controllers; appearance is device-local.
[Internationalization](internationalization.md) defines composition, catalogs
and formatting.

## Proposed tooling changes

TanStack Virtual remains selected; React Compiler is not enabled. A compiler or
virtualizer change needs separate evidence for React 19 support, runtime behavior
and compile eligibility. Compare prepend/tail anchoring, resident memory,
variable CJK/quote/image heights, keyboard/focus/read behavior and bundle output
under the same workload. Native chat anchoring is already in use. Virtua and
free React Virtuoso are possible comparison candidates; the commercial Message
List is not an adopted dependency.

Zustand remains deferred. The existing controllers manage resources, request
identity, cancellation and recovery, and their small subscription interfaces do
not justify another store. Reconsider if subscriptions proliferate or profiling
shows a benefit, while preserving state ownership and avoiding a second
canonical message store.

## Verification

Actual HTTP/socket producer validation is separate from handwritten response
fixtures. [Browser checks](../tests/e2e/README.md) establish geometry and native
storage behavior within their fixtures; physical devices, native IMEs and live
SFU delivery remain separate proofs under
[Readiness](readiness.md#evidence-limits).
