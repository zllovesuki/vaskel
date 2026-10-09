# Case study: when a precaution becomes a product requirement

A discussion about stale client code after deployment shows how an assistant
can turn a precaution into an unstated requirement, then carry it through
successive designs.

This case records the design discussion before implementation. The
[offline-shell contract](../client-storage.md#offline-application-shell) owns
application update behavior; [media participation](../media.md#user-visible-contract)
and [authored drafts](../client-storage.md#authored-drafts) own recovery and saved
work.

## The original problem

The user reported that a deployment did not update the client JavaScript until
the browser tab was closed and reopened. The requested outcome was a convenient
way to receive the deployed client, with bland offered as a reference.

Source inspection matched the symptom to a service worker serving the cached
application while its replacement waited for open tabs to close. The policy at
the time required complete installation and avoided forced reloads during calls.
Changing that policy needed an explicit decision.

The assistant proposed an update notice, then expanded its reload action to
include saving drafts, checking calls and uploads, and accounting for work in
other tabs. A request to update the app had become a requirement to check that
everything was ready to reload.

## How the extra guarantee survived simplification

The user questioned the complexity of that reload step. The assistant changed
the mechanism to independent tab updates: online navigation would fetch fresh
HTML, and each tab would reload separately while the service worker retained
its normal waiting lifecycle.

That approach introduced another problem. A waiting service worker no longer
reliably indicated whether the current page was outdated, because a reload
could already have fetched the latest client. The assistant proposed embedding
a build ID and polling a separate `/version.json` file.

Each proposal made sense given the assumption that updating one tab had to
leave every other tab undisturbed. The user had not requested that guarantee.
The assistant changed the mechanism but kept the requirement that made it
complicated.

The user then asked whether this familiar problem already had a standard
solution. The built-in PWA update prompt became the design baseline: detect a
waiting update, offer a reload action, and activate the downloaded worker when
the user accepts. Its possible effect on other app tabs remained a product
tradeoff to explain.

`/version.json` was not itself an anti-pattern. Version files are an established
technique, and independent tab updates can be a legitimate requirement. The
mistake was introducing machinery for a behavior whose value had not been
established. Complexity must be judged by the responsibility it serves, not
merely by code size or familiarity.

## What changed the assessment

The assistant had discussed call interruption before checking the existing
refresh recovery. When the user asked whether calls should automatically rejoin,
inspection confirmed that the client already attempts to resume retained call
intent after revalidating access, preserving the mute preference. Camera and
screen sharing require explicit restart, and browser audio restrictions can
require interaction.

Those distinctions changed the consequence being evaluated. Temporary
disconnection, restarting a screen share and losing authored work require
different responses. Grouping them together as disruption had made stronger
prevention seem necessary before existing recovery was considered.

The user also clarified the purpose of the two-tab example: help someone avoid
conflicting work while composing or sending in the same channel. That safeguard
belongs with the affected writing operation. It does not establish an obligation
for every tab to participate in an application-update protocol.

The Codex example illustrated a warning that the same session is already open
elsewhere. It supported a limited safeguard against conflicting work. Detailed
analysis of Codex's implementation added little once that point was understood.

## General lessons

| What happened                                                                                      | General lesson                                                                                                        |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A possible interruption became a reason to coordinate every tab.                                   | Establish the consequence and its importance before making prevention mandatory.                                      |
| A complexity objection led to another mechanism satisfying the same assumptions.                   | Review the requirements before replacing the mechanism.                                                               |
| Calls were treated as an update blocker before existing recovery was inspected.                    | Evaluate the remaining harm after recovery, including what already survives or resumes.                               |
| The standard library flow became the baseline late in the discussion.                              | Investigate existing mechanisms early, then justify departures from them.                                             |
| A duplicate-writer safeguard grew into a concern about seamless support for every tab arrangement. | Keep safeguards scoped to the action and state they protect.                                                          |
| An illustrative example prompted detailed implementation research.                                 | Identify the principle an example is meant to demonstrate and investigate enough to resolve the relevant uncertainty. |

A possible failure is evidence for a decision, not an automatic requirement to
prevent it. The decision depends on the supported workflow, the cost and
likelihood of the consequence, user intent, reversibility and available
recovery. An intentional update and an unsolicited background reload can
reasonably have different interruption policies.

Best-effort assistance can be useful without promising a seamless outcome for
every unusual usage pattern. Authorization, accepted-command identity,
stale-response rejection and protection of saved work retain their own
correctness requirements. Simplifying an optional precaution does not weaken
those guarantees.

## A better decision sequence

1. State the intended user experience and identify existing policies that would
   change.
2. Inspect the standard mechanism and the application's current recovery
   behavior.
3. Describe concrete remaining consequences and distinguish required guarantees
   from optional precautions.
4. Add only the mechanisms needed for those requirements. When complexity is
   challenged, revisit the premises before adding implementation detail.

The [startup skeleton case study](startup-skeleton.md) examined an optional
intermediate experience; the
[guarantees and coordination case study](guarantees-and-coordination.md)
examined the cost of stronger guarantees. This case adds a conversational
failure mode: an assistant can introduce a guarantee through risk discussion
and preserve it across revisions unless feedback triggers a review of the
premise itself.

## Evidence and limits

The source is the design discussion about client updates, duplicate tabs and
existing recovery, informed by repository and library inspection. This case
explains how the requirements changed during that discussion. The linked
contracts and tests describe the resulting implementation and its evidence
limits. The two-tab example establishes no channel-wide writing lock.
