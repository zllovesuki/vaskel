# Lounge design

Lounge uses warm neutral surfaces, stable person colours, a dark call stage and
grouped conversations. Visual changes must preserve routes, accessible names,
command identity and account and access boundaries.

## Tokens and identity

Use [theme tokens](../packages/ui/src/theme.css) for palettes, typography,
spacing, breakpoints and control sizes. Locale/font defaults are in
[base CSS](../packages/ui/src/base.css); shared geometry is in
[control styles](../packages/ui/src/components/control-styles.ts) and
[timeline CSS](../packages/ui/src/components/timeline.css).
Timeline styles load eagerly because the startup skeleton shares them.
[Home](../packages/ui/src/components/home.tsx),
[room](../packages/ui/src/components/room.tsx) and
[call](../packages/ui/src/components/call.tsx) parts are components that the
landing page's preview renders too, so it draws them as the app does. They own
markup, state styling and icons; each app supplies words, data and the element
that navigates (a router link here, a button in the preview). A class passed to
a shared style or component places it (margin, position, visibility) and never
restyles it: a same-property class loses to the shared one, so a needed
variation becomes an option.

Accent marks primary actions, links, unread position and broadcasting. Sidebar
selection stays neutral, while the call stage stays dark in both themes.
Interaction feedback must remain visible on its surface and preserve the
meaning of selected, mentioned and own-reaction colours. Leave and muted states
have separate semantic treatments. Shared styles own the exact colours and
hover, press and disabled treatments.

The [shared brand master](../packages/ui/src/brand.ts) supplies the product mark
for browser and operating-system surfaces. Pages use the wordmark. An
instance's own icon and name remain page content and do not replace the product
mark at browser level.

People have stable ID-derived hues with theme-controlled contrast; circles stay
neutral. Message/navigation avatars are rounded squares and call avatars
circular. DM title/hue follows the counterpart, not an arbitrary message author.
Use the shared [font policy](internationalization.md#typography-and-acceptance).
Body measure uses rem, not `ch`, to avoid narrowing CJK paragraphs.

Lengths come from theme tokens. The spacing step is independent of the type
root; padding, margins and gaps use spacing utilities, including half steps.
Explicit pixels are reserved for fixed dimensions and positions. Main-pane
regions share the page gutter so headers, content and the composer align.

Decorative icons stay out of accessibility; icon-only controls have names.
Hidden labels must remain inside their scroller rather than extending the page.
Use shared pointer targets, preserving the denser message-row exception and
larger menu touch targets. Shared
[status strips](../apps/client/src/ui/status-strip.tsx) keep wrapping labels and
actions aligned across notices.

## Home and navigation

Home contains account/search controls, authorized live calls, the Unread inbox,
collapsible circles with People/rooms, then DMs. Desktop places Home beside the
selected page. There is no separate icon rail, roster column or corner account
panel. Presence describes other people; an empty room should not count the
viewer as company.

Without a destination, restore this account's last local destination only after
validating it against the current directory, otherwise choose the first
available room or DM in directory order.
[Resource selection](../apps/client/src/features/workspace/resource-selection.ts)
owns that choice. Circles start collapsed except the current circle; deliberate
expansion is remembered locally and a collapsed circle keeps its current-room
label/unread roll-up.

Counts belong in Unread. Room/DM rows use bold plus a dot, or a bare `@` for
mentions, without repeating the same count. A newly encountered circle with no
opened rooms starts expanded, offers one dismissible first-room hint and labels
unopened populated rooms New; those rooms stay out of Unread until opened or the
new-circle hint is dismissed. This is per-device discovery state, not a server
read receipt.

On phones, opening Home replaces the visible pane while keeping the destination
mounted. Focus its close control, support Escape and restore focus to
navigation/main on close. Keep call controls reachable. Provide skip links to
the conversation and, where present, `composer-input`.
[Workspace](../apps/client/src/features/workspace/workspace.tsx) owns the layout and
focus lifetime.

The [workspace status strip](../apps/client/src/features/workspace/status.tsx)
sits at the top of the signed-in main pane, above the page header. Connection
and access feedback takes priority; an installed update otherwise offers
**Update now** until the page reloads. Keep the quiet surface, wrapping
text, polite status announcement and keyboard-accessible action. The action
follows the message and wraps beneath it on narrow panes without unbalancing
the strip; the chat reconnect and notification cleanup notices use the same
status strip. On phones, Home hides the strip with the main pane.
[Shell updates](client-storage.md#offline-application-shell) define activation
and recovery.

Account admission shows a workspace skeleton with bottom-anchored message
shapes, header and composer space. Then each section appears as its data arrives;
navigation remains usable while a destination loads, including on phones. Local
failures explain Retry in the affected section. Avoid premature
missing/access/reconnect claims. Startup, conversation loading and draft
restoration share composer geometry.
[Startup ownership](frontend.md#startup-and-reconnect) explains the
loading and recovery boundaries.

Loading placeholders replace unknown names, values, bodies and pictures with
shapes in one translucent ink colour. The shapes pulse together and remain
still under reduced motion. Section titles, field labels and action names stay
text. Placeholder rows share the geometry of the rows they precede,
and each placeholder announces one localized loading message. Background
refreshes retain existing content. A control whose request is running keeps its
dimensions and shows a progress mark with its pending label; short checks stay
text with the same mark.

## Search

Home's Search messages page focuses its phrase field. Search after a typing
pause or immediately on Enter, at or above the Unicode minimum. Repeating Enter
refreshes; Escape/clear clears phrase and results; circle/room filters apply
immediately. Committed query/filter state replaces the URL instead of adding
typing history. Cancel/discard stale responses. The cross-circle page explicitly
excludes DMs.

A fixed-height status line explains minimum length, pending, result count, empty
or failure; additional partial-coverage notes must not imply completeness.
Results use ordinary conversation rows with person identity, time, circle/room
and Open at message. [Search query](../apps/client/src/features/search/query.ts) owns
timing; [Messaging](messaging.md#search-admission-and-continuation) owns
authority and continuation.

In-room results form the active layer above an inert, faded transcript while
leaving the composer usable. Opening a result collapses the list to Show
results/Close search and restores the transcript. Showing results, changing the
phrase and closing reset the appropriate layer state.

## Timeline

Group consecutive same-author messages within five minutes. Author headers sit
above one shared timestamp/content/action row; skeletons use the same geometry.
Body/action measure keeps controls beside text on wide panes while hover/focus
treatment spans the row. Compact timestamps appear with hover, focus, an open
menu/picker or jump highlight. Full author/time remains accessible, with full
date/time titles.

Today/yesterday use localized relative-day formatting; other dates use locale
formatting with calendar-day/DST correctness. The unread divider captures the
position when opening and stays fixed while reading. A coincident day/unread
boundary shares one line. Short transcripts anchor at the bottom.

The transcript is one roving tab stop. Up/Down move rows, Home/End reach edges,
Left/Right traverse that row's controls, and Escape returns to the row. Open
edits/confirmations retain native order. Message actions use a dedicated
floating menu with no repeated metadata header; portal focus keeps the source
row highlighted. Trigger/menu opening must not change row height or scroll.
Preserve native touch selection, scrolling and child controls. Narrow headers
truncate with full text available in titles.

Reactions use the shared fixed emoji palette, compact rectangular chips, an
accent outline for the viewer's selections and dim pending toggles. Toolbar and
More both reach the picker; its caption names the focused/hovered emoji. Mention
chips display current names while
[the shared grammar](frontend.md#rendering-and-interaction-lifetimes) preserves
stable identity and literal code.

Opening a search result or `?at=` link focuses/highlights the message and
installs historical intent even near the newest row. The highlight warms the row
to the accent and settles back into its focus fill. Load newer approaches the
tail; Jump to latest restores following. The latest action floats over the
bottom instead of adding a layout row; unseen content gives it the Newer
messages below label/accent, with navigation failures above it. Resize reanchors
a following window so the control does not appear over an already-current last
row. [Synchronization](synchronization.md#bounded-resident-timeline) owns exact
read/anchor rules.

Quotes look like small messages: reply/forward icon, author/time/Open original,
then excerpt on a quiet tinted surface without an accent edge. Composer previews
use the same content without a nested frame and clamp narrowly so the phone
transcript remains usable. Expand based on real rendered overflow, including CJK
and cached history. Quotes never display source file previews.

## Composer

The writing area grows within bounded height above a fixed internal toolbar.
Shared gutters, separator, safe-area clearance and skeleton dimensions keep
status changes from moving conversation content. Quotes/files precede the field.
Attachment/emoji controls flank the information slot; Send sits at the right
with a larger touch target. [Control styles](../packages/ui/src/components/control-styles.ts)
own exact dimensions.

Enter inserts a newline; Shift+Enter sends after composition ends. Keep
focus/text-node identity stable during IME and incoming messages. The
placeholder names the destination. Shared input styles use
`touch-action: manipulation` to suppress automatic focus zoom while retaining
pan/pinch. The document requests keyboard-aware viewport resizing; physical
Android Firefox toolbar/keyboard overlap remains unproven by desktop emulation.

The [composer status](../apps/client/src/features/chat/composer-status.tsx)
selects copy and action together, prioritizing failures over ordinary activity.
Failures persist until resolved within the reserved height. Ordinary saving is
silent; Retry save and exceptional Clear draft stay inline. Uncertain Send
offers Retry with the original command. Keyboard hints stay on fine pointers.

Emoji insertion replaces the selection, preserves unaffected mention identities
and restores focus/caret. Picker lifetime follows the draft and edit admission;
losing access closes it without automatically reopening after recovery. Saved
draft indicators are quiet. A switcher appears only for multiple drafts; Forward
parks existing work. Emptying an ordinary draft clears it without replacing the
active input. Navigation does not prompt for saved new-message work, while
mounted inline message changes retain their guard.
[Draft contract](client-storage.md#authored-drafts) owns persistence and
uncertainty.

## Settings and entry screens

Account, circle and host settings share left alignment, page gutter and
[section framing](../apps/client/src/ui/settings-section.tsx): measured
forms/descriptions, full-width lists and separating hairlines. Lists are rows,
not cards. Headers identify the subject with its person/circle/instance
monogram. Inline room edits retain form measure and restore Edit focus when
closed; topics give way before room names, moving beneath on phones. Destructive
actions confirm in place, and the button that asked steps aside until the
question is answered.

Settings expose only the actions allowed by [Access](access.md). Keep host and
circle administration distinct from ordinary account controls. Wrong current
password stays inline. Blocked people shares the settings layout; unblocking
there confirms because the row disappears, while conversation controls remain
one click. Explain upload constraints and refusal beside the icon picker, and
give usage bars meaningful text. [Operations](operations.md#instance-administration)
owns host controls and maintenance recovery.

Sign-in uses a named instance's icon/name with a small product mark, or the
default wordmark once with its description. Entry screens add no separate header
link. Missing or expired invitation codes, incomplete or used verification
links, and a completed verification or password reset replace the form with an
explanation and one action: Sign in, or Return to vaskel. when signed in. The
verification page has no Back to sign in, since sign-in refuses unverified
accounts. After registration, sign-in stays on the page, and this browser
remembers the invitation until joined, refused or expired, so signing in from
the verification tab continues to Join.

## Calls

Voice rooms fill the dark stage; DMs have an initially open collapsible stage
above text. Screens occupy the main surface, cameras use tiles, and participant
chips show locally calculated speaking rings. Controls provide mic, camera,
share, deafen-self, devices and Leave.

Mount the stage from join start so pending/failed/reconnecting phases, Leave and
Reconnect remain there. When no registered stage is visible, desktop uses a Home
dock and phones a persistent mic/Open/Leave strip, including while Home is open.
Mount one responsive background control surface. Route matching alone cannot
hide it. Errors/transfer prompts remain within the owning surface.

Selected screens can use in-tab picture-in-picture above the composer, never
covering Send, with a named toggle and touch close control. It shares the
account session/audio owner. Hiding cameras must not drop a screen still visible
there; hiding both views releases screen reception.
[Frontend](frontend.md#persistent-media-presentation) owns the lifetime.

Live, muted, pending and restricted controls remain distinguishable without
colour alone and have accessible text. Participant geometry stays stable when
moderation controls appear. Leave remains destructive.
Missing SFU configuration is explained on voice-room and DM surfaces; only the
host gets the actionable deployment sentence. Disabled Join describes that
notice through `aria-describedby`.

## Motion

Motion acknowledges input, explains a change of state or place, or marks
arrival at a message; only loading shapes loop. Controls ease colour changes
briefly, and a press takes effect at once. Rows and menu items change without
easing, so pointer sweeps and arrow keys stay immediate. Openings preserve
spatial context; closing and theme changes are immediate. Shared styles own
individual transitions.

Reduced motion removes travel, scaling and rotation and stops loops. Colour and
opacity changes that carry state remain, and the message highlight holds
steady instead of settling. [Control styles](../packages/ui/src/components/control-styles.ts)
and [base CSS](../packages/ui/src/base.css) own timings and the reduced-motion
rule.

## Appearance and language

Appearance is device-local with System default, applied before first paint and
resilient to failed localStorage writes. Explicit Light overrides a dark system.
Account menu offers light/dark and language; settings retains System. Language
is account-wide and must preserve drafts/calls. Do not turn appearance into an
account preference without changing its contract.

[Internationalization](internationalization.md) owns regional font choice,
catalogs, input and acceptance. Chinese/Japanese headings avoid letter spacing;
fine text has a locale adjustment and times use 24-hour formatting. Actual font
coverage needs device review.

## Vocabulary

Use these names in interface copy and product descriptions. Routes, SQL, actors
and catalog keys retain code vocabulary. Avoid “group”/群組/群组/グループ for a
circle because those commonly mean one group chat. Teach terms in
creation/invitation flows.

| Code            | English        | 繁體中文   | 简体中文   | 日本語       |
| --------------- | -------------- | ---------- | ---------- | ------------ |
| server          | circle         | 圈子       | 圈子       | サークル     |
| text channel    | room           | 聊天室     | 聊天室     | トークルーム |
| media channel   | voice room     | 語音聊天室 | 语音聊天室 | ボイスルーム |
| server owner    | owner          | 圈主       | 圈主       | 主催者       |
| moderator       | moderator      | 版主       | 版主       | モデレーター |
| operator        | host           | 站長       | 站长       | 管理人       |
| conversation/DM | direct message | 私訊       | 私信       | DM           |
| instance        | this vaskel.     | 這個 vaskel. | 这个 vaskel. | この vaskel.   |

[Built browser checks](../tests/e2e/README.md) exercise presentation and
interaction. Native IME, assistive technology, native-speaker review and
physical-device behavior remain [separate acceptance](readiness.md#evidence-limits).
