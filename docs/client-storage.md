# Browser history, drafts and offline shell

Recent history is disposable downloaded content; drafts are authored work.
They use separate Dexie stores so evicting history cannot erase a draft. The
service worker stores public application assets. All private storage follows
the [account and request lifetime](frontend.md#request-and-account-lifetimes);
cached data grants no server authority.

## Read-only history

Dexie is confined to the
[storage adapter](../apps/client/src/features/cache/storage/index.ts). Typed tables,
account/history/draft transactions and schema live in
[database.ts](../apps/client/src/features/cache/storage/database.ts), following the
[development compatibility policy](../IMPLEMENTATION.md#development-compatibility).
Query remains the online timeline and is never hydrated from private history.

The cache retains one remembered account and bounded recent channel snapshots;
[model.ts](../apps/client/src/features/cache/model.ts) owns record/byte/channel
limits. Persist accepted messages, destination quote snapshots, attachment
descriptors and required display labels. Exclude credentials, authenticated
profiles, bookmarks, capabilities, downloaded files, search/activity results and
pending commands. Remembered account ID/label is display context, never local
authentication or a saved permission graph.

Strict record validation checks executable schemas, identity, owner/channel
membership, order, uniqueness and bounds. Saves, eviction and retirement compare
durable account/owner epochs and replay generation in overlapping native
transactions, awaiting commit. Missing/recreated control rows reject old
completions. Cross-tab notices carry invalidation identities only; transactions
remain decisive. A reactive database query cannot replace the distinction
between eviction and retirement.

Capacity eviction does not retire an active view. If owner metadata disappears
after an actual retirement, the account retirement revision makes focus recheck
conservatively. Corruption, denial, blocked upgrades and quota exhaustion
disable optional history without blocking
online messaging. A corrupt history read must not prevent account retirement
from purging draft bytes.

Logout, replacement and terminal authentication rejection purge account data.
Owner denial, replay-generation change/reset and known content invalidation
retire that scope; ordinary navigation and transient network loss do not.
Delayed exports cannot repopulate it.
[Timeline export rules](synchronization.md#bounded-resident-timeline) preserve
recent history while browsing older ranges and withhold edits/deletions before
pending saves settle.

A cold cached view mounts no authenticated workspace, composer, media controller
or read observer. A disconnected live document keeps its draft/files/controllers
but freezes interaction until [reconnect checks](frontend.md#startup-and-reconnect)
succeed. Ambiguous uploads/sends still require explicit status/receipt recovery.
An unreachable browser may retain stale downloaded content until
reconnect/removal; there is no complete-history
guarantee, offline lock or offline write queue.

## Authored drafts

The account draft manager lives above routes. Each draft owns text, mention
identities, quote reference, selected files, upload state and an exact Send
attempt. Navigation or a background Send cannot change another displayed draft.
Forward creates a new draft in the destination's normal composer, parking
existing work; a DM fully identifies its destination, while a circle needs a
room. Both require current send authority.

Draft metadata and File bytes live separately from history, with independent
retention. Ordered/debounced metadata saves flush on navigation/visibility;
editing text does not rewrite file bytes. Capacity failure retains live work and
an unsaved warning rather than evicting authored work. Uncommitted work enables
an unload warning. [Draft model](../apps/client/src/features/drafts/model.ts) owns
limits; [storage operations](../apps/client/src/features/cache/storage/drafts.ts) own
atomic persistence.

A Web Lock gives each saved draft one live editor, including its uploads and
Send. Another tab may create an independent draft. Restoration rereads after
acquiring the lock so work sent/discarded during the initial read cannot return.
This is browser-local persistence, with no cross-device draft synchronization.

Save quote references only; reload fetches previews under current source
permission. Restored uploads consult owner status; expired/interrupted attempts
can explicitly upload again from saved File bytes. A remote file ID alone is not
durable authored attachment storage.

Persist the immutable Send command before HTTP. A failed persistent write blocks
a new persistent Send; a tab without usable draft storage can retain unsaved
work in memory. Pending/uncertain attempts lock editing/uploads and keep the
same ID, issue time, body, quote and ordered file IDs. Reload offers explicit
Retry, never automatic delayed sending. Later source refusal cannot resolve an
earlier ambiguous commit. The
[draft controller](../apps/client/src/features/drafts/controller.ts) and
[message contract](messaging.md) own that uncertainty.

After an accepted Send, the draft controller removes the saved attempt and
local file bytes. If removal fails, the live controller retries local cleanup
without resending or canceling claimed uploads. A reload can still recover the
persisted attempt by retrying its exact command.

Manually emptying text/quote/files clears an ordinary draft while keeping the
current input stable; switching away removes its empty switcher entry. Only an
uncertain attempt exposes Clear draft, which abandons local work without
retracting a sent message. Normal saving is silent. Status priority and
accessible presentation belong to [Lounge](frontend-design.md#composer).

Account retirement purges drafts/files with the account fence in one IndexedDB
transaction. Confirmed destination access loss retires its separate draft-owner
epoch so delayed writes cannot return. History eviction/content invalidation
must not erase authored text. Inline message edits and exact edit/delete/remove
attempts remain conversation-owned and retain their navigation guard; they are
not saved new-message drafts. Offline authoring/queued sending remains deferred
despite online drafts surviving disconnection and reload.

## Offline application shell

The production-only [browser worker](../apps/client/src/sw.ts) uses Workbox precaching via
[the build transform](../apps/client/tools/pwa.ts). The source/HMR server registers no
worker. The manifest includes canonical HTML and approved emitted assets,
including lazy chunks/all supported catalogs, with SHA-256 integrity. Header
policy contributes to the HTML revision; header-only changes must update the
saved document. Unsupported assets fail the build rather than silently dropping
required files.

The font stylesheets are precached; their WOFF2 files, Latin and CJK alike,
load on demand through the HTTP cache and do not gate installation. Cold offline
text uses system fallbacks when a file is unavailable.

Fetch precache assets without credentials and accept only successful responses
with approved MIME. Only exact precached assets and known same-origin query-free
navigation use the shell. API/private files, tokens, sockets, debug/source paths
and arbitrary responses are excluded. No runtime private caching,
query-parameter ignoring, navigation preload or background send synchronization
is enabled.

Only a complete installation takes over. Failure leaves the prior active version
usable, possibly with inert candidate entries until successful activation cleans
obsolete revisions. The [registration module](../apps/client/src/shell/register.ts)
checks for updates after registration, when the tab becomes visible or
connectivity returns, and every five minutes. Checks run only while the page is
visible and online; failures retry on the next trigger.

Once installation succeeds, **Update now** in the
[workspace status strip](frontend-design.md#home-and-navigation) activates the
waiting worker through Vite PWA and reloads the current URL after it takes
control. This can also reload other tabs for the same instance in the browser
profile. The action does not wait for calls, uploads or other tabs to finish.
Without acceptance, the update waits until the old tabs close.

Canceling the browser's unload warning leaves the new worker active and the
update action available. Reload uses existing [draft recovery](#authored-drafts)
and [call recovery](media.md#user-visible-contract); uncertain messages still
require explicit Retry. Activation preserves unrelated caches and IndexedDB.
Workbox can repair an evicted known asset from an integrity-matched network
response.

Cold-offline verification needs an installed built shell, retained
IndexedDB/Cache Storage, a fresh deep link, cleared HTTP cache and an
unavailable server. Use synthetic configuration and a separate browser context;
another localhost port alone does not isolate cookies.
[Browser acceptance](../tests/e2e/README.md#choose-the-affected-cases) distinguishes
native build upgrades from application recovery with synthetic calls. Firefox,
Safari, physical storage pressure and deployed upgrades remain
[acceptance work](readiness.md#evidence-limits).
