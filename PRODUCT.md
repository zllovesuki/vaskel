# Product

The product name is **vaskel**, stylized as **vaskel.** with a trailing full stop.
Use the stylized form in interface copy, page titles, email subjects and documentation. Code
identifiers, package names, hostnames and paths use `vaskel` without the display
punctuation.

## Users

vaskel. serves people seeking a familiar Discord alternative for social text
conversations, calls and shared activities. Members should not need technical
knowledge. One host operates an independent Cloudflare instance containing
several circles, each with rooms; accounts and direct messages are shared across
the instance. Code and contracts retain `operator`, `server` and `channel` as
mapped in the [interface vocabulary](docs/frontend-design.md#vocabulary).

People might watch a game, share a coding session or talk with friends. The
product serves social groups beyond gaming communities.

## Product purpose

Provide a practical, invite-only social space where text chat, audio, camera
video and screen sharing coexist. Home brings together authorized live calls,
unread conversations, circles and direct messages. Navigation remains available
during media participation, with a persistent player when the call stage is
hidden. Instances do not federate.

Use familiar chat and call controls with little setup and a distinct visual
identity. Installation should avoid traditional server administration, and
normal community use should not expose infrastructure details.

## Design principles

Keep conversation continuous across text and media. Make participation,
mute/camera/share state and intentional leave unmistakable. Preserve one active
media session per account with explicit transfer between devices.

Keep host controls and circle administration distinct from daily conversation.
Show when a conversation is loading, reconnecting, unavailable or no longer
accessible.

Respect scoped privacy: private cross-device read state, no public read
receipts, circle-scoped audit authority and access to explicitly reported
material. Ordinary staff tools do not browse arbitrary DMs or deleted bodies.

Support CJK input and rendering. Launch UI languages are English, Simplified
Chinese, Traditional Chinese and Japanese. Explain the three-code-point body
search minimum when a query is too short.

## Anti-references

Avoid a pixel-for-pixel Discord clone, an infrastructure dashboard presented to
ordinary members, and decorative page choreography that interrupts long-running
chat. Do not import unrelated marketing layouts or backend topology from
reference projects.

## Accessibility and inclusion

Provide keyboard navigation, visible focus, semantic controls, readable
contrast, reduced-motion behavior and responsive layouts. Test real IMEs, mixed
scripts, grapheme/byte limits and CJK font coverage. Media shortcuts must
respect text input and composition.

Native IME, accessibility, capture and language review remain part of
[device and language acceptance](docs/readiness.md#evidence-limits).

## Policy and implementation references

See [Product policies](docs/product-review.md) for behavior and proposed features,
[Lounge design](docs/frontend-design.md) for layout and interaction, and
[Frontend](docs/frontend.md) for client state and synchronization.
