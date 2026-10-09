# Media participation

AccountMediaDO owns one account's participation and generations; MediaRoomDO
owns room control state; the message owner authorizes access. WebRTC payloads
travel through the operator's Realtime SFU.
See [Media transport](media-transport.md) for negotiation and forwarding cleanup.

## User-visible contract

Persistent voice rooms and DM calls allow audio, optional camera and
simultaneous screen sharing. Microphone, camera, screen video and screen audio
are distinct sources. Capture denial, autoplay restrictions, unsupported system
audio and recovery are normal presentation states. The logical room limit is 16
people, with separate [transport and transfer limits](media-transport.md#replacement-reception-and-source-removal).
Supported workloads still need [measurement](readiness.md#evidence-limits).

One account has one current participation across tabs/devices. Joining elsewhere
requires explicit Move. Refresh can resume the intended room with current
authorization and prior mute preference; camera/screen capture does not silently
restart. Leave, removal and permission revocation cancel inherited intent. A
cloned sessionStorage entry must not let a new tab resume somebody else's
endpoint. Room names, provider IDs and safe account status never supply a
capability.

Joining defaults to microphone capture unless a saved mute preference is active.
Muted entry requests no microphone access; unmuting captures the selected
microphone, and capture denial keeps the call muted. If the browser blocks
audio, Enable call audio resumes it. Active membership keeps the roster and
controls available while media setup waits.

The account controller survives navigation with one audio owner. Account-events
loss alone retains peers and roster; one handle-authorized heartbeat renews the
lease and returns call state. Transient network/server failures show reconnecting;
authoritative recovery stops peers while preserving the verified handle for
explicit Resume; terminal outcomes clear intent. Media readiness requires
the connections needed for current publications and subscriptions, not merely
a successful heartbeat.
[Frontend](frontend.md#persistent-media-presentation) owns call-surface
lifetimes.

## Device switching

Switching an active microphone or camera captures the selected device before
retiring the old track. Capture denial retains the current source and mute
preference. Compatible switches retain the publication and sender. If replacement
requires renegotiation, it uses the existing unpublish/publish exchange. The
producer queue owns both paths.

Leave, source stop and applicable moderation immediately stop acquired tracks,
including replacements waiting for negotiation. Capture requests still waiting
on the browser are fenced: any obsolete tracks they return are stopped before
use. Replacement preserves mute, preview and source-ended handling, and grants
no new forwarding authority.

## Replacement policy

Explicit transfer accepts a new current generation without waiting for the old
device, room or SFU to acknowledge disposal. Devices and listeners learn the
replacement through hints and refreshes, so they can switch at different times.
Transfer remains available when the predecessor fails, while preserving command
identity, current authorization and stale-generation rejection.

Room snapshots expose one current generation per person; new subscriptions
select its eligible publications. A listener synchronously disables and detaches
old-generation tracks before playing the replacement. Late tracks, snapshots and
answers cannot restore retired playback. Different listeners may switch at
different times, but each plays at most one generation. Independent
camera/screen sources remain valid.

The explicitly transferred predecessor is disposable: best-effort closure or
provider expiry cannot block replacement admission/subscription/completion. No
mandatory predecessor cleanup pointer or unbounded transfer-history ledger is
added. A missed retirement converges through participant lease expiry and
account-generation checks. Same-room admission retires eligible older
generations before counting participants, so replacing someone in a full room
does not consume another logical slot.

This exception applies to obsolete explicit-transfer resources. Resume, Leave,
moderation and permission revocation retain enforced forwarding/terminal-intent
barriers. Disposal is not proof of provider absence and cannot turn terminal
enforcement into best effort. A transfer during operational recovery can
proceed; it cannot override a pending deliberate Leave.
Join attempts report pending terminal cleanup instead of offering Move.
[Account lifecycle](../apps/server/src/actors/account-media/lifecycle.ts),
[claim checks](../apps/server/src/actors/account-media/claims.ts) and
[room disposal](../apps/server/src/actors/media/disposal.ts) implement the
distinction.

## Participation outcomes and closure

| Outcome                   | Required interpretation                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `recovery_required`       | Full owned endpoint was verified; intent survives but transport requires Resume. Accepted-command recovery retains the handle. |
| `participation_ended`     | Verified Leave/removal/revocation ended this intent; automatic recovery stops.                                                 |
| `action_restricted`       | This source/action is denied; participation survives.                                                                          |
| `publication_unavailable` | Remote source disappeared; participation survives.                                                                             |

Stale-generation rejection remains distinct from these ownership-verified
outcomes. Expired grants mean operational unavailability, not invented loss of
room permission. Before reservation an action-only restriction can fail locally.
After provider work, a failure requiring generation cleanup returns its retained
closure disposition. Completed exact retries keep their stored result; check
operation/version/phase before interpreting a restriction as new preflight.

Each generation retains its first closure cause. A terminal cause may replace an
operational cause until forwarding completes; a terminal cause is never
downgraded. After the participant is left the disposition is immutable, and a
new Remove against that ended generation is rejected. Delayed permission
invalidation still raises the permission floor and cancels older-grant account
intent, including recoverable intent without a live room row. The explicit
per-user floor decides revocation; an unexpired grant at or above that floor can
finish even when another owner permission change has produced a newer grant.
The participant's maximum observed grant generation advances monotonically,
preventing delayed invalidations from overwriting newer authority. Expiry,
endpoint identity, negotiation versions and current restrictions still apply.

For Resume, Leave and terminal enforcement, `closed` means forwarding cleanup
completed. Transfer retirement can report closure of application authority while
disposal remains best effort. Forwarding closure precedes removal notification.
A stalled account notification must not block the next participant's cleanup:
the wait is bounded while the underlying call keeps its work slot. Durable
notification retries continue until acknowledgement; the account may consume the
retained disposition independently.

Account predecessor cleanup commits a successor alarm before calling the room.
Its bounded caller wait uses the maintenance pool; an unsettled RPC retains
its exact room/generation slot across later alarms. A matching late
reply may settle a newer Leave's inherited predecessor while preserving that
command's generation, receipt and terminal cause. A replaced predecessor cannot
change newer authority. Timeout and late settlement recompute the complete
current predecessor/joining wake under the account's native transaction; idle
intent and permanent generation fences do not poll. Eviction recovers from the
persisted predecessor and alarm, without transfer-disposal acknowledgement or a
command-history table.

Moderation cancellation clears intent while preserving accepted generation,
endpoint ownership and receipt. It applies to current intent and a Resume
inheriting the previous generation; a fresh explicit Join/Transfer is not
canceled by an old generation's notification. Resume consumes the old-room
terminal barrier before admission; current-generation admission failure consumes
terminal disposition even for original Join. Expiry selections are rechecked in
the same transaction that starts closure after earlier external waits.

## Pending-command Leave

Leave identifies the current full handle or the exact pending
Join/Transfer/Resume, including capability and operation ID. Snapshot the
pending command before clearing local intent and prefer it over a predecessor
handle during Resume. Local capture/peer cleanup is immediate; an independent
Leave request handles server cancellation. Every delayed response remains
fenced.

AccountMediaDO matches the pending proof against the authenticated session,
operation, command ID and canonical fingerprint used by acceptance. A predicted
generation, client ID or stale handle is insufficient. Explicit Leave advances
the generation and retains its own session-bound receipt; later target retries
become stale. A pre-acceptance cancellation consumes the eligible
expected-generation comparison without admitting the target or allocating SFU
work.

| Ordering                                         | Result to preserve                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Leave overtakes initial Join                     | End only the eligible idle generation; never turn Join into implicit transfer of unrelated intent |
| Leave overtakes Resume                           | Verify/end the complete predecessor; delayed Resume cannot win                                    |
| Acceptance committed but reply is lost           | Match the exact receipt; clear intent and retain required current/predecessor cleanup             |
| An unrelated explicit command already won        | Reject the stale cancellation without ending the newer intent                                     |
| Original success arrives after Leave/replacement | Construct no peers and restore no intent; late provider allocations remain cleanup work           |

Cancel before confirming Move is local dismissal. After confirming Move, Leave
ends both that move and its predecessor at the Move's original expected
generation; it does not restore the old call. Canceling accepted Resume must
retain its existing predecessor cleanup pointer rather than replace it with an
unadmitted destination. Accepted Transfer has relinquished disposable
predecessor obligations, so Leave enforces the current admitted/admitting
generation. With no cleanup obligation, record Leave as completed immediately,
retaining its command receipt and retired capability fence.

If cancellation never reaches the server, it cannot infer deliberate Leave from
disconnect while also preserving refresh recovery. Report local departure and
unconfirmed server cancellation; lease expiry does not prove account intent was
canceled. There is no offline cancellation-delivery guarantee.
[Command normalization](../apps/server/src/actors/account-media/commands.ts)
binds cancellation to its original attempt.

## Verification and references

Real-device calls have been exercised with another participant. That use is
separate from the controlled fixtures and synthetic provider probes below.

Local actor tests use synthetic provider responses. The
[native browser fixtures](../tests/e2e/README.md#choose-the-affected-cases) exercise
production controllers and local peers; replacement rejection and suspended
audio policy are injected. They establish local lifecycle and playback behavior,
with physical-device compatibility and live-SFU delivery requiring separate
evidence.

Live SFU transfer evidence covers producer sessions after ACK, using production
Worker/browser code in local application runtimes, with isolated storage,
synthetic accounts and oscillator/canvas capture. It covers same-room and
cross-room transfer while predecessor closure is held or fails, one-generation
playback and forwarding enforcement with retained obsolete receiver tracks.
A complete old-room outage with lost retirement hints remains unverified.

[sources.json](sources.json) links the published provider guidance and retains
the reviewed source revisions and video-room example. Relevant patterns include
per-session queues, prepared-offer retries,
persisted membership before setup and allocation retention before rejecting
provider results. The example differs from vaskel. in its Cloudflare Access
identity, disposable room state and automatic capture/reconnect behavior.
